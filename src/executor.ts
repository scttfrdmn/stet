import type { Config } from './config.js'
import type { BundleResult } from './bundle.js'
import { Session } from './session.js'
import { estimateCostPerHour, estimateCost } from './cost.js'
import { BurstCostLimitError } from './errors.js'

export interface BurstOptions {
  workers?: number
  cpu?: number
  memory?: string
  backend?: 'fargate' | 'ec2'
  spot?: boolean
  maxCost?: number
  costAlert?: number
  timeout?: number
  region?: string
  signal?: AbortSignal
}

export function parseMemoryGb(memory: string): number {
  const upper = memory.toUpperCase().trim()
  if (upper.endsWith('GB')) {
    return parseFloat(upper.slice(0, -2))
  }
  if (upper.endsWith('MB')) {
    const mb = parseFloat(upper.slice(0, -2))
    return Math.max(1, Math.ceil(mb / 1024))
  }
  // Plain number assumed to be GB
  return parseFloat(memory)
}

export class Executor {
  private readonly _options: BurstOptions
  private _shutdown = false

  constructor(options?: BurstOptions) {
    this._options = options ?? {}
  }

  async map<T, U>(
    fn: (item: T) => Promise<U> | U,
    items: T[],
    overrides?: BurstOptions,
  ): Promise<U[]> {
    if (this._shutdown) {
      throw new Error('Executor has been shut down')
    }

    const opts = { ...this._options, ...overrides }

    const { loadConfig } = await import('./config.js')
    let cfg: Config = await loadConfig()
    if (opts.region) {
      cfg = { ...cfg, region: opts.region }
    }

    const { bundleFunction } = await import('./bundle.js')
    const { resolveWorkerImage } = await import('./env.js')

    const workers = opts.workers ?? cfg.defaultWorkers
    const cpu = opts.cpu ?? cfg.defaultCpu
    const memoryGb = opts.memory ? parseMemoryGb(opts.memory) : cfg.defaultMemoryGb

    // Cost limit check BEFORE any AWS calls
    if (opts.maxCost !== undefined) {
      const rate = estimateCostPerHour(cpu, memoryGb, workers)
      const est = estimateCost(cpu, memoryGb, workers, 1.0)
      if (est > opts.maxCost) {
        throw new BurstCostLimitError(opts.maxCost, est, [])
      }
    }

    const bundleResult: BundleResult = await bundleFunction(fn as Function)
    const imageUri = await resolveWorkerImage(bundleResult, cfg)

    const session = new Session({
      cfg,
      workers,
      cpu,
      memoryGb,
      backend: opts.backend ?? cfg.backend,
      spot: opts.spot ?? cfg.spot,
      maxCost: opts.maxCost,
      costAlert: opts.costAlert,
      timeout: opts.timeout,
    })

    const results = await session.run(
      items as unknown[],
      fn as Function,
      imageUri,
      bundleResult.bundle,
      opts.signal,
    )
    return results as U[]
  }

  async shutdown(): Promise<void> {
    this._shutdown = true
  }
}
