import { describe, it, expect } from 'vitest'
import {
  BurstError,
  BurstPartialError,
  BurstQuotaError,
  BurstCostLimitError,
  BurstTimeoutError,
  BurstSetupError,
} from '../../src/errors.js'
import type { SessionStatus } from '../../src/session.js'

describe('BurstError', () => {
  it('is an instance of Error', () => {
    const e = new BurstError('test')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(BurstError)
    expect(e.name).toBe('BurstError')
    expect(e.message).toBe('test')
  })
})

describe('BurstPartialError', () => {
  it('extends BurstError', () => {
    const e = new BurstPartialError([1, null], [null, new Error('fail')])
    expect(e).toBeInstanceOf(BurstError)
    expect(e).toBeInstanceOf(BurstPartialError)
    expect(e.name).toBe('BurstPartialError')
  })

  it('computes counts correctly', () => {
    const e = new BurstPartialError([1, null, 3], [null, new Error('fail'), null])
    expect(e.successCount).toBe(2)
    expect(e.failedCount).toBe(1)
    expect(e.results).toEqual([1, null, 3])
    expect(e.errors[1]).toBeInstanceOf(Error)
  })

  it('all failed', () => {
    const e = new BurstPartialError([null, null], [new Error('a'), new Error('b')])
    expect(e.failedCount).toBe(2)
    expect(e.successCount).toBe(0)
  })
})

describe('BurstQuotaError', () => {
  it('stores fields', () => {
    const e = new BurstQuotaError(100, 50, 'fargate_vcpu', 256)
    expect(e).toBeInstanceOf(BurstError)
    expect(e.name).toBe('BurstQuotaError')
    expect(e.requestedWorkers).toBe(100)
    expect(e.actualWorkers).toBe(50)
    expect(e.quotaName).toBe('fargate_vcpu')
    expect(e.quotaValue).toBe(256)
  })
})

describe('BurstCostLimitError', () => {
  it('stores fields', () => {
    const e = new BurstCostLimitError(1.0, 5.0, [1, 2])
    expect(e).toBeInstanceOf(BurstError)
    expect(e.name).toBe('BurstCostLimitError')
    expect(e.limit).toBe(1.0)
    expect(e.estimatedCost).toBe(5.0)
    expect(e.partialResults).toEqual([1, 2])
  })

  it('defaults partialResults to empty', () => {
    const e = new BurstCostLimitError(1.0, 2.0)
    expect(e.partialResults).toEqual([])
  })
})

describe('BurstTimeoutError', () => {
  it('stores fields', () => {
    const status: SessionStatus = {
      sessionId: 'ts-20260315-aabbccdd',
      status: 'running',
      tasksTotal: 5,
      tasksComplete: 2,
      tasksFailed: 0,
      workersActive: 3,
      elapsedSeconds: 60,
      costActual: 0.01,
      costEstimatePerHour: 1.0,
    }
    const e = new BurstTimeoutError('ts-20260315-aabbccdd', 60, status)
    expect(e).toBeInstanceOf(BurstError)
    expect(e.name).toBe('BurstTimeoutError')
    expect(e.sessionId).toBe('ts-20260315-aabbccdd')
    expect(e.timeoutSeconds).toBe(60)
    expect(e.status).toBe(status)
  })
})

describe('BurstSetupError', () => {
  it('stores fields', () => {
    const e = new BurstSetupError('config', 'missing field', 'run stet setup')
    expect(e).toBeInstanceOf(BurstError)
    expect(e.name).toBe('BurstSetupError')
    expect(e.step).toBe('config')
    expect(e.cause).toBe('missing field')
    expect(e.remediation).toBe('run stet setup')
  })
})
