/**
 * Integration test utilities for stet.
 *
 * Uses substrate as an AWS emulator. Set BURST_INTEGRATION_TEST=1 to enable.
 */

import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
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
  url: string
  cleanup: () => Promise<void>
}

export async function startSubstrateServer(): Promise<SubstrateServer> {
  const port = await freePort()
  const proc: ChildProcess = spawn('substrate', ['server', '--port', String(port)], {
    stdio: 'ignore',
  })

  const url = `http://localhost:${port}`
  await waitForHealth(`${url}/v1/health`)

  return {
    url,
    async cleanup() {
      proc.kill()
      await new Promise<void>((r) => proc.on('close', () => r()))
    },
  }
}

export async function resetSubstrate(url: string): Promise<void> {
  await fetch(`${url}/v1/reset`, { method: 'POST' })
}

export interface TestConfig {
  configPath: string
  s3Bucket: string
  region: string
}

export async function writeTestConfig(substrateUrl: string): Promise<TestConfig> {
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
  process.env['AWS_ENDPOINT_URL'] = substrateUrl
  process.env['AWS_ACCESS_KEY_ID'] = 'test'
  process.env['AWS_SECRET_ACCESS_KEY'] = 'test'
  process.env['AWS_DEFAULT_REGION'] = region

  return { configPath, s3Bucket, region }
}

export async function createBucket(s3: S3Client, bucket: string): Promise<void> {
  await s3.send(new CreateBucketCommand({ Bucket: bucket }))
}

/**
 * Simulate ECS workers by writing result + status files directly to S3.
 * This mirrors the adder test pattern: workers don't actually run,
 * we just write the expected output files.
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

    const resultKey = `sessions/${sessionId}/tasks/${taskId(i)}.result`
    const statusKey = `sessions/${sessionId}/tasks/${taskId(i)}.status`

    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: resultKey, Body: resultBuf }),
    )
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: statusKey,
        Body: Buffer.from('done'),
      }),
    )
  }
}
