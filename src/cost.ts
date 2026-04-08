export const FARGATE_VCPU_PER_HOUR = 0.04048
export const FARGATE_GB_PER_HOUR = 0.004445

export function estimateCostPerHour(
  cpu: number,
  memoryGb: number,
  workers: number,
): number {
  return workers * (cpu * FARGATE_VCPU_PER_HOUR + memoryGb * FARGATE_GB_PER_HOUR)
}

export function estimateCost(
  cpu: number,
  memoryGb: number,
  workers: number,
  hours: number,
): number {
  return estimateCostPerHour(cpu, memoryGb, workers) * hours
}

function stderr(msg: string): void {
  process.stderr.write(msg + '\n')
}

export function printStart(workers: number): void {
  stderr(`🚀 Starting ${workers} Fargate worker${workers === 1 ? '' : 's'}...`)
}

export function printCostEstimate(rate: number): void {
  stderr(`💰 Estimated cost: $${rate.toFixed(4)}/hr`)
}

export function printProcessing(total: number, workers: number): void {
  stderr(`📊 Processing ${total} item${total === 1 ? '' : 's'} across ${workers} worker${workers === 1 ? '' : 's'}`)
}

export function printChunks(chunks: number, avg: number): void {
  stderr(`📦 ${chunks} chunk${chunks === 1 ? '' : 's'} (avg ${avg.toFixed(1)} items each)`)
}

export function printSubmitted(n: number): void {
  stderr(`✓ ${n} task${n === 1 ? '' : 's'} submitted`)
}

export function printProgress(done: number, total: number, elapsed: string): void {
  stderr(`⏳ ${done}/${total} complete (${elapsed})`)
}

export function printCompleted(elapsed: string): void {
  stderr(`✓ Completed in ${elapsed}`)
}

export function printActualCost(cost: number): void {
  stderr(`💰 Actual cost: $${cost.toFixed(4)}`)
}

export function printQuotaWarning(
  req: number,
  reqVcpu: number,
  actual: number,
  actualVcpu: number,
): void {
  stderr(
    `⚠ Quota limit: requested ${req} workers (${reqVcpu} vCPU), using ${actual} workers (${actualVcpu} vCPU)`,
  )
}

export function printCostAlert(threshold: number): void {
  stderr(`⚠ Cost alert: approaching $${threshold.toFixed(4)} threshold`)
}
