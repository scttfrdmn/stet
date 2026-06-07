/**
 * Integration test utilities for stet.
 *
 * Substrate (default): BURST_INTEGRATION_TEST=1
 * Real AWS:            BURST_INTEGRATION_TEST=1  (with AWS credentials in env, no AWS_ENDPOINT_URL)
 */

import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { serialize } from 'node:v8'
import { taskId, chunkItems } from '../../src/session.js'

export function requireIntegration(): void {
  if (!process.env['BURST_INTEGRATION_TEST']) {
    throw new Error('Set BURST_INTEGRATION_TEST=1 to run integration tests')
  }
}

export function usingRealAws(): boolean {
  return !!process.env['BURST_USE_REAL_AWS']
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function waitForHealth(url: string, maxMs = 10000): Promise<void> {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url)
      if (resp.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`substrate server did not become healthy at ${url}`)
}

export interface SubstrateServer {
  url: string | null
  cleanup: () => Promise<void>
}

export async function startSubstrateServer(): Promise<SubstrateServer> {
  if (usingRealAws()) {
    return { url: null, async cleanup() {} }
  }

  const port = await freePort()
  const proc: ChildProcess = spawn('substrate', ['server', '--address', `:${port}`], {
    stdio: 'ignore',
  })

  const url = `http://localhost:${port}`
  await waitForHealth(`${url}/health`)

  return {
    url,
    async cleanup() {
      proc.kill()
      await new Promise<void>((r) => proc.on('close', () => r()))
    },
  }
}

export async function resetSubstrate(substrateServer: SubstrateServer): Promise<void> {
  if (substrateServer.url) {
    await fetch(`${substrateServer.url}/v1/state/reset`, { method: 'POST' })
  }
}

export interface TestConfig {
  configPath: string
  s3Bucket: string
  region: string
}

export async function writeTestConfig(substrateServer: SubstrateServer): Promise<TestConfig> {
  if (usingRealAws()) {
    // Use real ~/.burst/config.json
    const configPath = join(homedir(), '.burst', 'config.json')
    const raw = JSON.parse(await readFile(configPath, 'utf-8')) as Record<string, unknown>
    return {
      configPath,
      s3Bucket: raw['s3_bucket'] as string,
      region: raw['region'] as string,
    }
  }

  const region = 'us-east-1'
  const s3Bucket = `burst-${region}`
  const configPath = join(tmpdir(), `stet-test-config-${randomBytes(4).toString('hex')}.json`)

  const diskConfig = {
    region,
    s3_bucket: s3Bucket,
    ecs_cluster: 'burst-cluster',
    ecr_base_uri: `123456789012.dkr.ecr.${region}.amazonaws.com`,
    execution_role_arn: `arn:aws:iam::123456789012:role/burst-execution-role`,
    task_role_arn: `arn:aws:iam::123456789012:role/burst-task-role`,
    default_cpu: 1,
    default_memory_gb: 2,
    default_workers: 5,
  }

  await writeFile(configPath, JSON.stringify(diskConfig))
  process.env['BURST_CONFIG_PATH'] = configPath
  process.env['AWS_ENDPOINT_URL'] = substrateServer.url!
  process.env['AWS_ACCESS_KEY_ID'] = 'test'
  process.env['AWS_SECRET_ACCESS_KEY'] = 'test'
  process.env['AWS_DEFAULT_REGION'] = region

  return { configPath, s3Bucket, region }
}

export async function makeS3Client(substrateServer: SubstrateServer, region: string): Promise<S3Client> {
  if (usingRealAws()) {
    return new S3Client({ region })
  }
  return new S3Client({
    region,
    endpoint: substrateServer.url!,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
}

export async function createBucket(s3: S3Client, bucket: string, region: string): Promise<void> {
  try {
    const cmd: ConstructorParameters<typeof CreateBucketCommand>[0] = { Bucket: bucket }
    if (region !== 'us-east-1') {
      cmd.CreateBucketConfiguration = { LocationConstraint: region as never }
    }
    await s3.send(new CreateBucketCommand(cmd))
  } catch (e: unknown) {
    const name = (e as { name?: string }).name
    if (name !== 'BucketAlreadyExists' && name !== 'BucketAlreadyOwnedByYou') {
      throw e
    }
  }
}

/**
 * Simulate ECS workers by writing result + status files directly to S3.
 */
export async function simulateWorkers(
  s3: S3Client,
  bucket: string,
  sessionId: string,
  items: unknown[],
  fn: (item: unknown) => unknown,
  nWorkers: number,
): Promise<void> {
  const chunks = chunkItems(items, nWorkers)
  for (let i = 0; i < chunks.length; i++) {
    const results = chunks[i]!.map((item) => fn(item))
    const resultBuf = serialize(results)

    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: `sessions/${sessionId}/tasks/${taskId(i)}.result`, Body: resultBuf,
    }))
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: `sessions/${sessionId}/tasks/${taskId(i)}.status`, Body: Buffer.from('done'),
    }))
  }
}
