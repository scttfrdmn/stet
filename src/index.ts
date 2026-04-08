export { map } from './map.js'
export { Pool } from './pool.js'
export { Executor, type BurstOptions, parseMemoryGb } from './executor.js'
export { attach, type SessionStatus } from './session.js'
export {
  BurstError,
  BurstPartialError,
  BurstQuotaError,
  BurstCostLimitError,
  BurstTimeoutError,
  BurstSetupError,
} from './errors.js'

export const VERSION = '0.1.0'
