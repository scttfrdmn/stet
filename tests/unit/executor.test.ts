import { describe, it, expect, vi, afterEach } from 'vitest'
import { Executor, parseMemoryGb } from '../../src/executor.js'
import { BurstCostLimitError } from '../../src/errors.js'

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
})
