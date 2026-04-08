import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BurstSetupError } from './errors.js'

export interface Config {
  region: string
  s3Bucket: string
  ecsCluster: string
  ecrBaseUri: string
  executionRoleArn: string
  taskRoleArn: string
  defaultCpu: number
  defaultMemoryGb: number
  defaultWorkers: number
  maxCostPerJob: number
  costAlertThreshold: number
  backend: 'fargate' | 'ec2'
  spot: boolean
  fargateQuotaVcpu: number
}

/** On-disk JSON uses snake_case to match Go/Python config */
interface ConfigDisk {
  region?: string
  s3_bucket?: string
  ecs_cluster?: string
  ecr_base_uri?: string
  execution_role_arn?: string
  task_role_arn?: string
  default_cpu?: number
  default_memory_gb?: number
  default_workers?: number
  max_cost_per_job?: number
  cost_alert_threshold?: number
  backend?: 'fargate' | 'ec2'
  spot?: boolean
  fargate_quota_vcpu?: number
}

const DEFAULTS: Config = {
  region: 'us-east-1',
  s3Bucket: '',
  ecsCluster: 'burst-cluster',
  ecrBaseUri: '',
  executionRoleArn: '',
  taskRoleArn: '',
  defaultCpu: 1,
  defaultMemoryGb: 2,
  defaultWorkers: 10,
  maxCostPerJob: 10.0,
  costAlertThreshold: 5.0,
  backend: 'fargate',
  spot: false,
  fargateQuotaVcpu: 256,
}

function diskToConfig(d: ConfigDisk): Config {
  return {
    region: d.region ?? DEFAULTS.region,
    s3Bucket: d.s3_bucket ?? DEFAULTS.s3Bucket,
    ecsCluster: d.ecs_cluster ?? DEFAULTS.ecsCluster,
    ecrBaseUri: d.ecr_base_uri ?? DEFAULTS.ecrBaseUri,
    executionRoleArn: d.execution_role_arn ?? DEFAULTS.executionRoleArn,
    taskRoleArn: d.task_role_arn ?? DEFAULTS.taskRoleArn,
    defaultCpu: d.default_cpu ?? DEFAULTS.defaultCpu,
    defaultMemoryGb: d.default_memory_gb ?? DEFAULTS.defaultMemoryGb,
    defaultWorkers: d.default_workers ?? DEFAULTS.defaultWorkers,
    maxCostPerJob: d.max_cost_per_job ?? DEFAULTS.maxCostPerJob,
    costAlertThreshold: d.cost_alert_threshold ?? DEFAULTS.costAlertThreshold,
    backend: d.backend ?? DEFAULTS.backend,
    spot: d.spot ?? DEFAULTS.spot,
    fargateQuotaVcpu: d.fargate_quota_vcpu ?? DEFAULTS.fargateQuotaVcpu,
  }
}

function configToDisk(c: Config): ConfigDisk {
  return {
    region: c.region,
    s3_bucket: c.s3Bucket,
    ecs_cluster: c.ecsCluster,
    ecr_base_uri: c.ecrBaseUri,
    execution_role_arn: c.executionRoleArn,
    task_role_arn: c.taskRoleArn,
    default_cpu: c.defaultCpu,
    default_memory_gb: c.defaultMemoryGb,
    default_workers: c.defaultWorkers,
    max_cost_per_job: c.maxCostPerJob,
    cost_alert_threshold: c.costAlertThreshold,
    backend: c.backend,
    spot: c.spot,
    fargate_quota_vcpu: c.fargateQuotaVcpu,
  }
}

function configPath(): string {
  const env = process.env['BURST_CONFIG_PATH']
  if (env) return env
  return join(homedir(), '.burst', 'config.json')
}

export async function loadConfig(): Promise<Config> {
  const path = configPath()
  if (!existsSync(path)) {
    return { ...DEFAULTS }
  }
  const raw = await readFile(path, 'utf-8')
  const disk = JSON.parse(raw) as ConfigDisk
  return diskToConfig(disk)
}

export async function saveConfig(cfg: Config): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  const disk = configToDisk(cfg)
  await writeFile(path, JSON.stringify(disk, null, 2) + '\n', { mode: 0o600 })
}

export function validateConfig(cfg: Config): void {
  const required: Array<keyof Config> = [
    'region',
    's3Bucket',
    'ecrBaseUri',
    'executionRoleArn',
    'taskRoleArn',
  ]
  for (const field of required) {
    if (!cfg[field]) {
      throw new BurstSetupError(
        'config',
        `Missing required field: ${field}`,
        "Run 'stet setup' to configure the burst environment",
      )
    }
  }
}
