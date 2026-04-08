/**
 * Integration tests for stet using substrate as an AWS emulator.
 *
 * These tests verify the full orchestration pipeline:
 *   - task file upload to S3
 *   - ECS RunTask calls (mocked at _launchWorkers)
 *   - S3 polling and result collection
 *   - result ordering
 *
 * Since ECS workers won't actually execute inside substrate, we use
 * simulateWorkers() to write result files directly.
 *
 * Requires: BURST_INTEGRATION_TEST=1 and substrate in PATH.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3'
import {
  requireIntegration,
  startSubstrateServer,
  resetSubstrate,
  writeTestConfig,
  createBucket,
  simulateWorkers,
  type SubstrateServer,
  type TestConfig,
} from './helpers.js'
import { Session, generateSessionId, chunkItems } from '../../src/session.js'
import type { Config } from '../../src/config.js'
import { loadConfig } from '../../src/config.js'

requireIntegration()

let substrateServer: SubstrateServer
let testConfig: TestConfig
let cfg: Config
let s3: S3Client

beforeAll(async () => {
  substrateServer = await startSubstrateServer()
  testConfig = await writeTestConfig(substrateServer.url)
  cfg = await loadConfig()
  s3 = new S3Client({
    region: testConfig.region,
    endpoint: substrateServer.url,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  })
}, 30000)

afterAll(async () => {
  await substrateServer.cleanup()
})

beforeEach(async () => {
  await resetSubstrate(substrateServer.url)
  await createBucket(s3, testConfig.s3Bucket)
})

function makeSession(overrides?: Partial<Parameters<typeof Session>[0]>): Session {
  return new Session({
    cfg,
    workers: 3,
    cpu: 1,
    memoryGb: 2,
    timeout: 30,
    ...(overrides ?? {}),
  })
}

describe('basic ordering', () => {
  it('returns 10 items in correct order with 3 workers', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const fn = (x: unknown) => (x as number) * 2

    const session = makeSession()
    let capturedSessionId = ''

    vi.spyOn(session, '_launchWorkers').mockImplementation(
      async (_ecs, _s3, sessionId, _imageUri, _chunkCount) => {
        capturedSessionId = sessionId
        await simulateWorkers(s3, testConfig.s3Bucket, sessionId, items, fn, 3)
      },
    )

    const results = await session.run(items, fn, 'fake-uri', Buffer.from('bundle'))
    expect(results).toEqual(items.map((x) => x * 2))
    expect(capturedSessionId).toMatch(/^ts-\d{8}-[0-9a-f]{8}$/)
  }, 35000)
})

describe('out-of-order chunk completion', () => {
  it('still returns results in original item order', async () => {
    const items = Array.from({ length: 15 }, (_, i) => i)
    const fn = (x: unknown) => (x as number) ** 2

    const session = makeSession({ workers: 5 })
    const { S3Client: _S3 } = await import('@aws-sdk/client-s3')
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const { serialize } = await import('node:v8')
    const { taskId } = await import('../../src/session.js')

    vi.spyOn(session, '_launchWorkers').mockImplementation(
      async (_ecs, _s3client, sessionId) => {
        const chunks = chunkItems(items, 5)
        // Write in reverse order to test ordering
        for (let i = chunks.length - 1; i >= 0; i--) {
          const results = chunks[i]!.map((x) => (x as number) ** 2)
          const buf = serialize(results)
          await s3.send(
            new PutObjectCommand({
              Bucket: testConfig.s3Bucket,
              Key: `sessions/${sessionId}/tasks/${taskId(i)}.result`,
              Body: buf,
            }),
          )
          await s3.send(
            new PutObjectCommand({
              Bucket: testConfig.s3Bucket,
              Key: `sessions/${sessionId}/tasks/${taskId(i)}.status`,
              Body: Buffer.from('done'),
            }),
          )
        }
      },
    )

    const results = await session.run(items, fn, 'fake-uri', Buffer.from('bundle'))
    expect(results).toEqual(items.map((x) => x ** 2))
  }, 35000)
})

describe('task files in S3', () => {
  it('task files are present before workers launch', async () => {
    const items = [1, 2, 3, 4, 5]
    const fn = (x: unknown) => (x as number) + 1
    const { encodeTaskFile } = await import('../../src/serialize.js')
    const bundle = Buffer.from('fake bundle')

    const session = makeSession({ workers: 2 })
    const taskFilesAtLaunch: string[] = []

    vi.spyOn(session, '_launchWorkers').mockImplementation(
      async (_ecs, _s3client, sessionId, _uri, chunkCount) => {
        // At launch time, task files should be in S3
        const resp = await s3.send(
          new ListObjectsV2Command({
            Bucket: testConfig.s3Bucket,
            Prefix: `sessions/${sessionId}/tasks/`,
          }),
        )
        for (const obj of resp.Contents ?? []) {
          if (obj.Key) taskFilesAtLaunch.push(obj.Key)
        }
        // Simulate workers
        await simulateWorkers(s3, testConfig.s3Bucket, sessionId, items, fn, chunkCount)
      },
    )

    await session.run(items, fn, 'fake-uri', bundle)

    const dotTaskFiles = taskFilesAtLaunch.filter((k) => k.endsWith('.task'))
    expect(dotTaskFiles.length).toBeGreaterThanOrEqual(1)
  }, 35000)
})

describe('manifest', () => {
  it('manifest is written with correct session ID', async () => {
    const items = [1, 2, 3]
    const fn = (x: unknown) => x

    const session = makeSession({ workers: 1 })
    let capturedSessionId = ''

    vi.spyOn(session, '_launchWorkers').mockImplementation(
      async (_ecs, _s3, sessionId, _uri, chunkCount) => {
        capturedSessionId = sessionId
        await simulateWorkers(s3, testConfig.s3Bucket, sessionId, items, fn, chunkCount)
      },
    )

    await session.run(items, fn, 'fake-uri', Buffer.from('bundle'))

    const resp = await s3.send(
      new GetObjectCommand({
        Bucket: testConfig.s3Bucket,
        Key: `sessions/${capturedSessionId}/manifest.json`,
      }),
    )
    const chunks: Buffer[] = []
    for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk))
    }
    const manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>
    expect(manifest['session_id']).toBe(capturedSessionId)
    expect(manifest['status']).toBe('running')
  }, 35000)
})

describe('cleanup', () => {
  it('task files are deleted after run (manifest kept)', async () => {
    const items = [1, 2]
    const fn = (x: unknown) => x

    const session = makeSession({ workers: 1 })
    let capturedSessionId = ''

    vi.spyOn(session, '_launchWorkers').mockImplementation(
      async (_ecs, _s3, sessionId, _uri, chunkCount) => {
        capturedSessionId = sessionId
        await simulateWorkers(s3, testConfig.s3Bucket, sessionId, items, fn, chunkCount)
      },
    )

    await session.run(items, fn, 'fake-uri', Buffer.from('bundle'))

    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: testConfig.s3Bucket,
        Prefix: `sessions/${capturedSessionId}/`,
      }),
    )

    const keys = (resp.Contents ?? []).map((o) => o.Key ?? '')
    const taskFiles = keys.filter((k) => !k.endsWith('manifest.json'))
    const manifestFiles = keys.filter((k) => k.endsWith('manifest.json'))

    expect(taskFiles).toHaveLength(0)
    expect(manifestFiles).toHaveLength(1)
  }, 35000)
})
