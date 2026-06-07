import { describe, it, expect, vi, afterEach } from 'vitest'
import { Executor, parseMemoryGb } from '../../src/executor.js'
import { BurstCostLimitError, BurstPartialError } from '../../src/errors.js'

describe('parseMemoryGb', () => {
  it('parses "4GB" → 4', () => expect(parseMemoryGb('4GB')).toBe(4))
  it('parses "512MB" → 1 (rounded up)', () => expect(parseMemoryGb('512MB')).toBe(1))
  it('parses "2048MB" → 2', () => expect(parseMemoryGb('2048MB')).toBe(2))
  it('parses "8gb" (case insensitive)', () => expect(parseMemoryGb('8gb')).toBe(8))
  it('parses plain number as GB', () => expect(parseMemoryGb('2')).toBe(2))
  it('parses "1.5GB"', () => expect(parseMemoryGb('1.5GB')).toBeCloseTo(1.5))
})

describe('Executor', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws when shut down', async () => {
    const exec = new Executor()
    await exec.shutdown()
    await expect(exec.map((x: number) => x, [1, 2, 3])).rejects.toThrow('shut down')
  })

  it('throws BurstCostLimitError before AWS when cost exceeds maxCost', async () => {
    const exec = new Executor({ workers: 1000, cpu: 16, memory: '32GB', maxCost: 0.01 })

    // Mock loadConfig so we don't need a real config file
    vi.mock('../../src/config.js', () => ({
      loadConfig: async () => ({
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
      }),
      saveConfig: async () => {},
      validateConfig: () => {},
    }))

    await expect(exec.map((x: number) => x, [1, 2, 3])).rejects.toThrow(BurstCostLimitError)
  })

  describe('mapTolerant', () => {
    it('returns null for failed items instead of throwing', async () => {
      const exec = new Executor()

      // Spy on the internal Session.runTolerant via the Session module
      const sessionModule = await import('../../src/session.js')
      const runTolerantSpy = vi
        .spyOn(sessionModule.Session.prototype, 'runTolerant')
        .mockResolvedValue([0, null, 4])

      // Mock dependencies so we don't need real AWS
      vi.doMock('../../src/config.js', () => ({
        loadConfig: async () => ({
          region: 'us-east-1',
          s3Bucket: 'burst-test',
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
        }),
      }))
      vi.doMock('../../src/bundle.js', () => ({
        bundleFunction: async () => ({ bundle: Buffer.from(''), entryPoint: 'index.js' }),
      }))
      vi.doMock('../../src/env.js', () => ({
        resolveWorkerImage: async () => '123.dkr.ecr.us-east-1.amazonaws.com/stet-workers:test',
      }))

      const results = await exec.mapTolerant((x: number) => x * 2, [0, 1, 2])

      expect(results[0]).toBe(0)
      expect(results[1]).toBeNull()
      expect(results[2]).toBe(4)

      runTolerantSpy.mockRestore()
    })

    it('does not throw BurstPartialError when session returns partial results', async () => {
      const exec = new Executor()

      const sessionModule = await import('../../src/session.js')
      // Simulate the tolerant path: runTolerant catches BurstPartialError and returns nulls
      vi.spyOn(sessionModule.Session.prototype, 'runTolerant').mockImplementation(async () => {
        // Internally it catches BurstPartialError — just return the tolerant result
        return [42, null, 84]
      })

      vi.doMock('../../src/config.js', () => ({
        loadConfig: async () => ({
          region: 'us-east-1',
          s3Bucket: 'burst-test',
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
        }),
      }))
      vi.doMock('../../src/bundle.js', () => ({
        bundleFunction: async () => ({ bundle: Buffer.from(''), entryPoint: 'index.js' }),
      }))
      vi.doMock('../../src/env.js', () => ({
        resolveWorkerImage: async () => '123.dkr.ecr.us-east-1.amazonaws.com/stet-workers:test',
      }))

      await expect(exec.mapTolerant((x: number) => x * 2, [1, 2, 3])).resolves.not.toThrow()
    })

    it('throws when shut down', async () => {
      const exec = new Executor()
      await exec.shutdown()
      await expect(exec.mapTolerant((x: number) => x, [1, 2, 3])).rejects.toThrow('shut down')
    })
  })
})
