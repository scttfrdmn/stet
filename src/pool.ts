import type { Config } from './config.js'
import type { BundleResult } from './bundle.js'
import { Session } from './session.js'
import { type BurstOptions, parseMemoryGb } from './executor.js'

export class Pool {
  private readonly _options: BurstOptions
  private _shutdown = false
  private _cfg: Config | null = null
  private _imageUri: string | null = null
  private _bundleResult: BundleResult | null = null
  private _lastFn: Function | null = null

  constructor(options?: BurstOptions) {
    this._options = options ?? {}
  }

  async map<T, U>(
    items: T[],
    fn: (item: T) => Promise<U> | U,
  ): Promise<U[]> {
    if (this._shutdown) {
      throw new Error('Pool has been shut down')
    }

    if (!this._cfg) {
      const { loadConfig } = await import('./config.js')
      this._cfg = await loadConfig()
      if (this._options.region) {
        this._cfg = { ...this._cfg, region: this._options.region }
      }
    }

    const cfg = this._cfg
    const workers = this._options.workers ?? cfg.defaultWorkers
    const cpu = this._options.cpu ?? cfg.defaultCpu
    const memoryGb = this._options.memory
      ? parseMemoryGb(this._options.memory)
      : cfg.defaultMemoryGb

    // Re-bundle only if fn changed
    if (!this._bundleResult || this._lastFn !== (fn as Function)) {
      const { bundleFunction } = await import('./bundle.js')
      this._bundleResult = await bundleFunction(fn as Function)
      this._lastFn = fn as Function

      // Invalidate image cache on new bundle
      this._imageUri = null
    }

    if (!this._imageUri) {
      const { resolveWorkerImage } = await import('./env.js')
      this._imageUri = await resolveWorkerImage(this._bundleResult, cfg)
    }

    const session = new Session({
      cfg,
      workers,
      cpu,
      memoryGb,
      backend: this._options.backend ?? cfg.backend,
      spot: this._options.spot ?? cfg.spot,
      maxCost: this._options.maxCost,
      costAlert: this._options.costAlert,
      timeout: this._options.timeout,
    })

    const results = await session.run(
      items as unknown[],
      fn as Function,
      this._imageUri,
      this._bundleResult.bundle,
      this._options.signal,
    )
    return results as U[]
  }

  async shutdown(): Promise<void> {
    this._shutdown = true
  }
}
