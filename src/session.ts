import { randomBytes } from 'node:crypto'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import {
  ECSClient,
  RunTaskCommand,
  DescribeTasksCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs'
import type { Config } from './config.js'
import { encodeTaskFile, decodeResult } from './serialize.js'
import {
  estimateCostPerHour,
  estimateCost,
  printStart,
  printCostEstimate,
  printProcessing,
  printChunks,
  printSubmitted,
  printProgress,
  printCompleted,
  printActualCost,
  printQuotaWarning,
  printCostAlert,
} from './cost.js'
import {
  BurstPartialError,
  BurstCostLimitError,
  BurstTimeoutError,
  BurstQuotaError,
} from './errors.js'

export interface SessionStatus {
  sessionId: string
  status: 'pending' | 'running' | 'complete' | 'failed' | 'partial'
  tasksTotal: number
  tasksComplete: number
  tasksFailed: number
  workersActive: number
  elapsedSeconds: number
  costActual: number
  costEstimatePerHour: number
}

/** Generate session ID: ts-{yyyymmdd}-{random8hex} */
export function generateSessionId(): string {
  const now = new Date()
  const date =
    String(now.getUTCFullYear()) +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0')
  const rand = randomBytes(4).toString('hex')
  return `ts-${date}-${rand}`
}

/** Zero-padded task ID: task-0000 */
export function taskId(index: number): string {
  return `task-${String(index).padStart(4, '0')}`
}

export function chunkItems<T>(items: T[], n: number): T[][] {
  if (items.length === 0) return []
  const chunkSize = Math.ceil(items.length / n)
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

function makeManifest(
  sessionId: string,
  status: string,
  tasksTotal: number,
  tasksComplete: number,
  tasksFailed: number,
  workersActive: number,
  elapsedSeconds: number,
  costActual: number,
  costEstimatePerHour: number,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    status,
    tasks_total: tasksTotal,
    tasks_complete: tasksComplete,
    tasks_failed: tasksFailed,
    workers_active: workersActive,
    elapsed_seconds: elapsedSeconds,
    cost_actual: costActual,
    cost_estimate_per_hour: costEstimatePerHour,
    ...extra,
  }
}

function s3Client(cfg: Config): S3Client {
  return new S3Client({ region: cfg.region })
}

function ecsClient(cfg: Config): ECSClient {
  return new ECSClient({ region: cfg.region })
}

async function s3Get(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const chunks: Buffer[] = []
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function s3Put(
  s3: S3Client,
  bucket: string,
  key: string,
  body: Buffer | string,
): Promise<void> {
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buf }))
}

async function s3GetText(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const buf = await s3Get(s3, bucket, key)
    return buf.toString('utf-8').trim()
  } catch {
    return null
  }
}

function taskKey(sessionId: string, index: number, suffix: string): string {
  return `sessions/${sessionId}/tasks/${taskId(index)}.${suffix}`
}

export interface SessionOptions {
  cfg: Config
  workers: number
  cpu: number
  memoryGb: number
  backend?: 'fargate' | 'ec2'
  spot?: boolean
  maxCost?: number
  costAlert?: number
  timeout?: number
}

export class Session {
  private readonly _cfg: Config
  private readonly _workers: number
  private readonly _cpu: number
  private readonly _memoryGb: number
  private readonly _backend: 'fargate' | 'ec2'
  private readonly _spot: boolean
  private readonly _maxCost?: number
  private readonly _costAlert?: number
  private readonly _timeout?: number

  constructor(options: SessionOptions) {
    this._cfg = options.cfg
    this._workers = options.workers
    this._cpu = options.cpu
    this._memoryGb = options.memoryGb
    this._backend = options.backend ?? 'fargate'
    this._spot = options.spot ?? false
    this._maxCost = options.maxCost
    this._costAlert = options.costAlert
    this._timeout = options.timeout
  }

  async run(
    items: unknown[],
    fn: Function,
    imageUri: string,
    bundle: Buffer,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    // Cost limit check BEFORE any AWS calls
    const ratePerHour = estimateCostPerHour(this._cpu, this._memoryGb, this._workers)
    if (this._maxCost !== undefined) {
      const estimatedHours = 1.0
      const est = estimateCost(this._cpu, this._memoryGb, this._workers, estimatedHours)
      if (est > this._maxCost) {
        throw new BurstCostLimitError(this._maxCost, est, [])
      }
    }

    const sessionId = generateSessionId()
    const s3 = s3Client(this._cfg)
    const ecs = ecsClient(this._cfg)

    const actualWorkers = Math.min(this._workers, items.length)
    const chunks = chunkItems(items, actualWorkers)
    const chunkCount = chunks.length

    // Check quota
    const totalVcpu = actualWorkers * this._cpu
    const quotaVcpu = this._cfg.fargateQuotaVcpu
    let usedWorkers = actualWorkers
    if (totalVcpu > quotaVcpu) {
      usedWorkers = Math.floor(quotaVcpu / this._cpu)
      printQuotaWarning(actualWorkers, totalVcpu, usedWorkers, usedWorkers * this._cpu)
      throw new BurstQuotaError(actualWorkers, usedWorkers, 'fargate_vcpu', quotaVcpu)
    }

    printStart(actualWorkers)
    printCostEstimate(ratePerHour)
    printProcessing(items.length, actualWorkers)
    printChunks(chunkCount, items.length / chunkCount)

    // Step 1: Upload tasks to S3
    await Promise.all(
      chunks.map((chunk, i) => {
        const taskBuf = encodeTaskFile(bundle, chunk)
        return s3Put(s3, this._cfg.s3Bucket, taskKey(sessionId, i, 'task'), taskBuf)
      }),
    )

    // Step 2: Write manifest
    await s3Put(
      s3,
      this._cfg.s3Bucket,
      `sessions/${sessionId}/manifest.json`,
      JSON.stringify(
        makeManifest(
          sessionId,
          'running',
          chunkCount,
          0,
          0,
          actualWorkers,
          0,
          0,
          ratePerHour,
          {
            chunk_count: chunkCount,
            cpu: this._cpu,
            memory_gb: this._memoryGb,
            workers_actual: actualWorkers,
          },
        ),
      ),
    )

    // Step 3: Launch ECS workers
    await this._launchWorkers(ecs, s3, sessionId, imageUri, chunkCount)
    printSubmitted(chunkCount)

    // Step 4: Poll until done
    const startTime = Date.now()
    const deadline =
      this._timeout !== undefined ? startTime + this._timeout * 1000 : undefined

    await this._pollUntilDone(
      s3,
      sessionId,
      chunkCount,
      startTime,
      deadline,
      ratePerHour,
      signal,
    )

    // Step 5: Collect results
    const results = await this._downloadResults(s3, sessionId, chunkCount)

    const elapsed = (Date.now() - startTime) / 1000
    printCompleted(`${elapsed.toFixed(1)}s`)
    const actualCost = estimateCost(
      this._cpu,
      this._memoryGb,
      actualWorkers,
      elapsed / 3600,
    )
    printActualCost(actualCost)

    // Step 6: Cleanup
    await this._cleanupTasks(s3, sessionId, chunkCount)

    return results
  }

  async _launchWorkers(
    ecs: ECSClient,
    s3: S3Client,
    sessionId: string,
    imageUri: string,
    chunkCount: number,
  ): Promise<void> {
    for (let i = 0; i < chunkCount; i++) {
      const tid = taskId(i)
      await ecs.send(
        new RunTaskCommand({
          cluster: this._cfg.ecsCluster,
          taskDefinition: imageUri,
          launchType: this._backend === 'fargate' ? 'FARGATE' : 'EC2',
          overrides: {
            containerOverrides: [
              {
                name: 'worker',
                environment: [
                  { name: 'BURST_SESSION_ID', value: sessionId },
                  { name: 'BURST_TASK_ID', value: tid },
                  { name: 'BURST_S3_BUCKET', value: this._cfg.s3Bucket },
                  { name: 'BURST_REGION', value: this._cfg.region },
                ],
              },
            ],
          },
          networkConfiguration:
            this._backend === 'fargate'
              ? {
                  awsvpcConfiguration: {
                    subnets: [],
                    assignPublicIp: 'ENABLED',
                  },
                }
              : undefined,
        }),
      )
    }
  }

  private async _pollUntilDone(
    s3: S3Client,
    sessionId: string,
    chunkCount: number,
    startTime: number,
    deadline: number | undefined,
    ratePerHour: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        if (signal?.aborted) {
          clearInterval(interval)
          reject(new Error('Aborted'))
          return
        }

        const now = Date.now()
        if (deadline !== undefined && now >= deadline) {
          clearInterval(interval)
          const elapsedSeconds = (now - startTime) / 1000
          const status: SessionStatus = {
            sessionId,
            status: 'running',
            tasksTotal: chunkCount,
            tasksComplete: 0,
            tasksFailed: 0,
            workersActive: 0,
            elapsedSeconds,
            costActual: 0,
            costEstimatePerHour: ratePerHour,
          }
          reject(new BurstTimeoutError(sessionId, (deadline - startTime) / 1000, status))
          return
        }

        try {
          const { done, failed } = await this._countStatuses(s3, sessionId, chunkCount)
          const elapsed = (now - startTime) / 1000
          const elapsedStr = `${elapsed.toFixed(1)}s`

          if (this._costAlert !== undefined) {
            const costSoFar = estimateCost(
              this._cpu,
              this._memoryGb,
              chunkCount,
              elapsed / 3600,
            )
            if (costSoFar >= this._costAlert) {
              printCostAlert(this._costAlert)
            }
          }

          printProgress(done + failed, chunkCount, elapsedStr)

          if (done + failed >= chunkCount) {
            clearInterval(interval)
            if (failed > 0) {
              // Collect partial results for error
              const results = await this._downloadResultsPartial(
                s3,
                sessionId,
                chunkCount,
              )
              const errors: (Error | null)[] = results.map((r, i) =>
                r === null ? new Error(`Task ${i} failed`) : null,
              )
              reject(new BurstPartialError(results, errors))
            } else {
              resolve()
            }
          }
        } catch (err) {
          if (err instanceof BurstPartialError) {
            reject(err)
          }
          // Ignore transient S3 errors during polling
        }
      }, 2000)
    })
  }

  async _countStatuses(
    s3: S3Client,
    sessionId: string,
    chunkCount: number,
  ): Promise<{ done: number; failed: number }> {
    let done = 0
    let failed = 0
    const statuses = await Promise.all(
      Array.from({ length: chunkCount }, (_, i) =>
        s3GetText(s3, this._cfg.s3Bucket, taskKey(sessionId, i, 'status')),
      ),
    )
    for (const status of statuses) {
      if (status === 'done') done++
      else if (status === 'failed') failed++
    }
    return { done, failed }
  }

  private async _downloadResults(
    s3: S3Client,
    sessionId: string,
    chunkCount: number,
  ): Promise<unknown[]> {
    const chunks = await Promise.all(
      Array.from({ length: chunkCount }, async (_, i) => {
        const buf = await s3Get(s3, this._cfg.s3Bucket, taskKey(sessionId, i, 'result'))
        return decodeResult(buf)
      }),
    )
    return chunks.flat()
  }

  private async _downloadResultsPartial(
    s3: S3Client,
    sessionId: string,
    chunkCount: number,
  ): Promise<(unknown | null)[]> {
    const results: (unknown | null)[] = []
    for (let i = 0; i < chunkCount; i++) {
      try {
        const buf = await s3Get(s3, this._cfg.s3Bucket, taskKey(sessionId, i, 'result'))
        const items = decodeResult(buf)
        results.push(...items)
      } catch {
        results.push(null)
      }
    }
    return results
  }

  async _cleanupTasks(
    s3: S3Client,
    sessionId: string,
    chunkCount: number,
  ): Promise<void> {
    const keys: { Key: string }[] = []
    for (let i = 0; i < chunkCount; i++) {
      keys.push({ Key: taskKey(sessionId, i, 'task') })
      keys.push({ Key: taskKey(sessionId, i, 'result') })
      keys.push({ Key: taskKey(sessionId, i, 'status') })
      keys.push({ Key: taskKey(sessionId, i, 'error') })
    }
    // Delete in batches of 1000 (S3 limit)
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: this._cfg.s3Bucket,
          Delete: { Objects: batch },
        }),
      )
    }
  }
}

export class DetachedSession {
  readonly sessionId: string
  private readonly _cfg: Config

  constructor(options: { sessionId: string; cfg: Config }) {
    this.sessionId = options.sessionId
    this._cfg = options.cfg
  }

  async status(): Promise<SessionStatus> {
    const s3 = s3Client(this._cfg)
    const buf = await s3Get(
      s3,
      this._cfg.s3Bucket,
      `sessions/${this.sessionId}/manifest.json`,
    )
    const manifest = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>
    return {
      sessionId: manifest['session_id'] as string,
      status: manifest['status'] as SessionStatus['status'],
      tasksTotal: manifest['tasks_total'] as number,
      tasksComplete: manifest['tasks_complete'] as number,
      tasksFailed: manifest['tasks_failed'] as number,
      workersActive: manifest['workers_active'] as number,
      elapsedSeconds: manifest['elapsed_seconds'] as number,
      costActual: manifest['cost_actual'] as number,
      costEstimatePerHour: manifest['cost_estimate_per_hour'] as number,
    }
  }

  async collect(timeout?: number, signal?: AbortSignal): Promise<unknown[]> {
    const manifest = await this.status()
    const chunkCount = (manifest as unknown as Record<string, unknown>)['tasksTotal'] as number

    // Re-read manifest for chunk_count
    const s3 = s3Client(this._cfg)
    const buf = await s3Get(
      s3,
      this._cfg.s3Bucket,
      `sessions/${this.sessionId}/manifest.json`,
    )
    const rawManifest = JSON.parse(buf.toString('utf-8')) as Record<string, unknown>
    const totalChunks = (rawManifest['chunk_count'] as number | undefined) ?? manifest.tasksTotal

    const ratePerHour = manifest.costEstimatePerHour
    const startTime = Date.now()
    const deadline = timeout !== undefined ? startTime + timeout * 1000 : undefined

    const sess = new Session({
      cfg: this._cfg,
      workers: totalChunks,
      cpu: (rawManifest['cpu'] as number | undefined) ?? 1,
      memoryGb: (rawManifest['memory_gb'] as number | undefined) ?? 1,
      timeout,
    })

    await sess['_pollUntilDone'](
      s3,
      this.sessionId,
      totalChunks,
      startTime,
      deadline,
      ratePerHour,
      signal,
    )

    const chunks = await Promise.all(
      Array.from({ length: totalChunks }, async (_, i) => {
        const key = `sessions/${this.sessionId}/tasks/${taskId(i)}.result`
        const resultBuf = await s3Get(s3, this._cfg.s3Bucket, key)
        return decodeResult(resultBuf)
      }),
    )
    return chunks.flat()
  }

  async cleanup(): Promise<void> {
    const s3 = s3Client(this._cfg)
    // List all objects under the session prefix
    const prefix = `sessions/${this.sessionId}/`
    const keys: { Key: string }[] = []

    let continuationToken: string | undefined
    do {
      const resp = await s3.send(
        new ListObjectsV2Command({
          Bucket: this._cfg.s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      )
      for (const obj of resp.Contents ?? []) {
        if (obj.Key) keys.push({ Key: obj.Key })
      }
      continuationToken = resp.NextContinuationToken
    } while (continuationToken)

    if (keys.length === 0) return

    // Delete in batches of 1000
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000)
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: this._cfg.s3Bucket,
          Delete: { Objects: batch },
        }),
      )
    }
  }
}

export async function attach(sessionId: string, cfg?: Config): Promise<DetachedSession> {
  if (!cfg) {
    const { loadConfig } = await import('./config.js')
    cfg = await loadConfig()
  }
  return new DetachedSession({ sessionId, cfg })
}
