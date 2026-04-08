import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  generateSessionId,
  taskId,
  chunkItems,
  Session,
  DetachedSession,
  attach,
  type SessionOptions,
} from '../../src/session.js'
import { BurstTimeoutError, BurstCostLimitError, BurstPartialError } from '../../src/errors.js'
import type { Config } from '../../src/config.js'
import { encodeResult } from '../../src/serialize.js'

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    region: 'us-east-1',
    s3Bucket: 'burst-us-east-1',
    ecsCluster: 'burst-cluster',
    ecrBaseUri: '123.dkr.ecr.us-east-1.amazonaws.com',
    executionRoleArn: 'arn:aws:iam::123:role/exec',
    taskRoleArn: 'arn:aws:iam::123:role/task',
    defaultCpu: 1,
    defaultMemoryGb: 2,
    defaultWorkers: 10,
    maxCostPerJob: 10.0,
    costAlertThreshold: 5.0,
    backend: 'fargate',
    spot: false,
    fargateQuotaVcpu: 256,
    ...overrides,
  }
}

describe('generateSessionId', () => {
  it('matches ts-{yyyymmdd}-{random8hex} format', () => {
    const id = generateSessionId()
    expect(id).toMatch(/^ts-\d{8}-[0-9a-f]{8}$/)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, generateSessionId))
    expect(ids.size).toBe(100)
  })
})

describe('taskId', () => {
  it('zero-pads to 4 digits', () => {
    expect(taskId(0)).toBe('task-0000')
    expect(taskId(1)).toBe('task-0001')
    expect(taskId(9999)).toBe('task-9999')
    expect(taskId(42)).toBe('task-0042')
  })
})

describe('chunkItems', () => {
  it('splits evenly', () => {
    const chunks = chunkItems([1, 2, 3, 4], 2)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual([1, 2])
    expect(chunks[1]).toEqual([3, 4])
  })

  it('handles remainder', () => {
    const chunks = chunkItems([1, 2, 3, 4, 5], 2)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual([1, 2, 3])
    expect(chunks[1]).toEqual([4, 5])
  })

  it('fewer items than workers', () => {
    const chunks = chunkItems([1, 2], 5)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toEqual([1])
    expect(chunks[1]).toEqual([2])
  })

  it('empty array', () => {
    expect(chunkItems([], 5)).toEqual([])
  })

  it('preserves order', () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    const chunks = chunkItems(items, 3)
    const flat = chunks.flat()
    expect(flat).toEqual(items)
  })

  it('single item single worker', () => {
    expect(chunkItems([42], 1)).toEqual([[42]])
  })
})

describe('Session', () => {
  it('throws BurstCostLimitError before AWS calls when cost exceeds max', async () => {
    const cfg = makeConfig()
    const session = new Session({
      cfg,
      workers: 1000,
      cpu: 16,
      memoryGb: 32,
      maxCost: 0.01,
    })

    await expect(
      session.run([1, 2, 3], (x: unknown) => x, 'fake-uri', Buffer.from('bundle')),
    ).rejects.toThrow(BurstCostLimitError)
  })

  it('throws BurstTimeoutError when timeout=0', async () => {
    const cfg = makeConfig()
    const session = new Session({
      cfg,
      workers: 3,
      cpu: 1,
      memoryGb: 1,
      timeout: 0,
    })

    // Mock _launchWorkers so it doesn't call AWS
    vi.spyOn(session, '_launchWorkers').mockResolvedValue(undefined)

    // Mock S3/ECS calls to do nothing (tasks never complete)
    const { S3Client } = await import('@aws-sdk/client-s3')
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (cmd) => {
      const name = cmd.constructor.name
      if (name === 'PutObjectCommand') return {}
      if (name === 'GetObjectCommand') throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' })
      return {}
    })

    await expect(
      session.run([1, 2, 3], (x: unknown) => x, 'fake-uri', Buffer.from('bundle')),
    ).rejects.toThrow(BurstTimeoutError)

    vi.restoreAllMocks()
  }, 10000)
})

describe('DetachedSession.status', () => {
  it('parses manifest from S3', async () => {
    const cfg = makeConfig()
    const ds = new DetachedSession({ sessionId: 'ts-20260315-aabbccdd', cfg })

    const manifest = {
      session_id: 'ts-20260315-aabbccdd',
      status: 'running',
      tasks_total: 5,
      tasks_complete: 3,
      tasks_failed: 0,
      workers_active: 2,
      elapsed_seconds: 15.3,
      cost_actual: 0.0,
      cost_estimate_per_hour: 2.5,
    }

    const { S3Client } = await import('@aws-sdk/client-s3')
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Body: {
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify(manifest))
        },
      },
    } as never)

    const status = await ds.status()
    expect(status.sessionId).toBe('ts-20260315-aabbccdd')
    expect(status.status).toBe('running')
    expect(status.tasksTotal).toBe(5)
    expect(status.tasksComplete).toBe(3)

    vi.restoreAllMocks()
  })
})

describe('attach', () => {
  it('returns DetachedSession with given ID', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { randomBytes } = await import('node:crypto')

    const dir = join(tmpdir(), randomBytes(4).toString('hex'))
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'config.json')

    const origPath = process.env['BURST_CONFIG_PATH']
    process.env['BURST_CONFIG_PATH'] = path

    await writeFile(
      path,
      JSON.stringify({
        region: 'us-east-1',
        s3_bucket: 'burst-us-east-1',
        ecr_base_uri: 'x',
        execution_role_arn: 'y',
        task_role_arn: 'z',
      }),
    )

    const ds = await attach('ts-20260315-test01')
    expect(ds).toBeInstanceOf(DetachedSession)
    expect(ds.sessionId).toBe('ts-20260315-test01')

    if (origPath === undefined) delete process.env['BURST_CONFIG_PATH']
    else process.env['BURST_CONFIG_PATH'] = origPath
  })
})
