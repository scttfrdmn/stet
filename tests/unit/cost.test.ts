import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  FARGATE_VCPU_PER_HOUR,
  FARGATE_GB_PER_HOUR,
  estimateCostPerHour,
  estimateCost,
  printStart,
  printCostEstimate,
  printActualCost,
} from '../../src/cost.js'

describe('constants', () => {
  it('FARGATE_VCPU_PER_HOUR', () => {
    expect(FARGATE_VCPU_PER_HOUR).toBe(0.04048)
  })
  it('FARGATE_GB_PER_HOUR', () => {
    expect(FARGATE_GB_PER_HOUR).toBe(0.004445)
  })
})

describe('estimateCostPerHour', () => {
  it('single worker, 1 vCPU, 2 GB', () => {
    const rate = estimateCostPerHour(1, 2, 1)
    expect(rate).toBeCloseTo(FARGATE_VCPU_PER_HOUR + 2 * FARGATE_GB_PER_HOUR, 8)
  })

  it('scales linearly with workers', () => {
    const single = estimateCostPerHour(1, 1, 1)
    const ten = estimateCostPerHour(1, 1, 10)
    expect(ten).toBeCloseTo(single * 10, 8)
  })

  it('zero workers is zero cost', () => {
    expect(estimateCostPerHour(1, 2, 0)).toBe(0)
  })
})

describe('estimateCost', () => {
  it('zero hours is zero cost', () => {
    expect(estimateCost(1, 2, 10, 0)).toBe(0)
  })

  it('one hour matches estimateCostPerHour', () => {
    expect(estimateCost(2, 4, 5, 1)).toBeCloseTo(estimateCostPerHour(2, 4, 5), 8)
  })

  it('half hour is half cost', () => {
    const full = estimateCost(1, 2, 3, 1)
    const half = estimateCost(1, 2, 3, 0.5)
    expect(half).toBeCloseTo(full / 2, 8)
  })
})

describe('print functions write to stderr', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('printStart writes to stderr', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    printStart(5)
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('5'))
  })

  it('printCostEstimate writes rate', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    printCostEstimate(1.2345)
    const call = spy.mock.calls[0]![0] as string
    expect(call).toContain('1.2345')
  })

  it('printActualCost formats to 4 decimals', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    printActualCost(0.1)
    const call = spy.mock.calls[0]![0] as string
    expect(call).toContain('0.1000')
  })
})
