import type { SessionStatus } from './session.js'

export class BurstError extends Error {
  override name = 'BurstError'
  constructor(message: string) {
    super(message)
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class BurstPartialError extends BurstError {
  override name = 'BurstPartialError'
  readonly results: (unknown | null)[]
  readonly errors: (Error | null)[]
  readonly failedCount: number
  readonly successCount: number

  constructor(results: (unknown | null)[], errors: (Error | null)[]) {
    const failed = errors.filter((e) => e !== null).length
    const success = results.filter((r) => r !== null).length
    super(`${failed} of ${results.length} tasks failed`)
    this.results = results
    this.errors = errors
    this.failedCount = failed
    this.successCount = success
  }
}

export class BurstQuotaError extends BurstError {
  override name = 'BurstQuotaError'
  readonly requestedWorkers: number
  readonly actualWorkers: number
  readonly quotaName: string
  readonly quotaValue: number

  constructor(
    requestedWorkers: number,
    actualWorkers: number,
    quotaName: string,
    quotaValue: number,
  ) {
    super(
      `Requested ${requestedWorkers} workers but quota ${quotaName} allows only ${quotaValue} (using ${actualWorkers})`,
    )
    this.requestedWorkers = requestedWorkers
    this.actualWorkers = actualWorkers
    this.quotaName = quotaName
    this.quotaValue = quotaValue
  }
}

export class BurstCostLimitError extends BurstError {
  override name = 'BurstCostLimitError'
  readonly limit: number
  readonly estimatedCost: number
  readonly partialResults: unknown[]

  constructor(limit: number, estimatedCost: number, partialResults: unknown[] = []) {
    super(
      `Estimated cost $${estimatedCost.toFixed(4)} exceeds limit $${limit.toFixed(4)}`,
    )
    this.limit = limit
    this.estimatedCost = estimatedCost
    this.partialResults = partialResults
  }
}

export class BurstTimeoutError extends BurstError {
  override name = 'BurstTimeoutError'
  readonly sessionId: string
  readonly timeoutSeconds: number
  readonly status: SessionStatus

  constructor(sessionId: string, timeoutSeconds: number, status: SessionStatus) {
    super(`Session ${sessionId} timed out after ${timeoutSeconds}s`)
    this.sessionId = sessionId
    this.timeoutSeconds = timeoutSeconds
    this.status = status
  }
}

export class BurstSetupError extends BurstError {
  override name = 'BurstSetupError'
  readonly step: string
  readonly cause: string
  readonly remediation: string

  constructor(step: string, cause: string, remediation: string) {
    super(`Setup failed at ${step}: ${cause}`)
    this.step = step
    this.cause = cause
    this.remediation = remediation
  }
}
