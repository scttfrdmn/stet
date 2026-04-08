import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { loadConfig, saveConfig, validateConfig, type Config } from '../../src/config.js'
import { BurstSetupError } from '../../src/errors.js'

function tempDir(): string {
  return join(tmpdir(), `stet-test-${randomBytes(4).toString('hex')}`)
}

describe('loadConfig', () => {
  let dir: string
  let origPath: string | undefined

  beforeEach(async () => {
    dir = tempDir()
    await mkdir(dir, { recursive: true })
    origPath = process.env['BURST_CONFIG_PATH']
  })

  afterEach(() => {
    if (origPath === undefined) {
      delete process.env['BURST_CONFIG_PATH']
    } else {
      process.env['BURST_CONFIG_PATH'] = origPath
    }
  })

  it('returns defaults when file missing', async () => {
    process.env['BURST_CONFIG_PATH'] = join(dir, 'nonexistent.json')
    const cfg = await loadConfig()
    expect(cfg.region).toBe('us-east-1')
    expect(cfg.ecsCluster).toBe('burst-cluster')
  })

  it('reads snake_case disk format and converts to camelCase', async () => {
    const path = join(dir, 'config.json')
    process.env['BURST_CONFIG_PATH'] = path
    const disk = {
      region: 'eu-west-1',
      s3_bucket: 'my-bucket',
      ecs_cluster: 'my-cluster',
      ecr_base_uri: '123.dkr.ecr.eu-west-1.amazonaws.com',
      execution_role_arn: 'arn:aws:iam::123:role/exec',
      task_role_arn: 'arn:aws:iam::123:role/task',
    }
    await writeFile(path, JSON.stringify(disk))
    const cfg = await loadConfig()
    expect(cfg.region).toBe('eu-west-1')
    expect(cfg.s3Bucket).toBe('my-bucket')
    expect(cfg.ecsCluster).toBe('my-cluster')
    expect(cfg.ecrBaseUri).toBe('123.dkr.ecr.eu-west-1.amazonaws.com')
    expect(cfg.executionRoleArn).toBe('arn:aws:iam::123:role/exec')
    expect(cfg.taskRoleArn).toBe('arn:aws:iam::123:role/task')
  })

  it('respects BURST_CONFIG_PATH env var', async () => {
    const path = join(dir, 'custom.json')
    process.env['BURST_CONFIG_PATH'] = path
    await writeFile(path, JSON.stringify({ region: 'ap-southeast-1' }))
    const cfg = await loadConfig()
    expect(cfg.region).toBe('ap-southeast-1')
  })
})

describe('saveConfig', () => {
  let dir: string
  let origPath: string | undefined

  beforeEach(async () => {
    dir = tempDir()
    await mkdir(dir, { recursive: true })
    origPath = process.env['BURST_CONFIG_PATH']
  })

  afterEach(() => {
    if (origPath === undefined) {
      delete process.env['BURST_CONFIG_PATH']
    } else {
      process.env['BURST_CONFIG_PATH'] = origPath
    }
  })

  it('save / load roundtrip', async () => {
    const path = join(dir, 'config.json')
    process.env['BURST_CONFIG_PATH'] = path
    const cfg: Config = {
      region: 'us-west-2',
      s3Bucket: 'burst-us-west-2',
      ecsCluster: 'burst-cluster',
      ecrBaseUri: '123.dkr.ecr.us-west-2.amazonaws.com',
      executionRoleArn: 'arn:aws:iam::123:role/exec',
      taskRoleArn: 'arn:aws:iam::123:role/task',
      defaultCpu: 2,
      defaultMemoryGb: 4,
      defaultWorkers: 5,
      maxCostPerJob: 5.0,
      costAlertThreshold: 2.5,
      backend: 'fargate',
      spot: false,
      fargateQuotaVcpu: 256,
    }
    await saveConfig(cfg)
    const loaded = await loadConfig()
    expect(loaded.region).toBe('us-west-2')
    expect(loaded.s3Bucket).toBe('burst-us-west-2')
    expect(loaded.defaultCpu).toBe(2)
  })

  it('writes file with mode 0o600', async () => {
    const path = join(dir, 'config.json')
    process.env['BURST_CONFIG_PATH'] = path
    const cfg = await loadConfig()
    await saveConfig(cfg)
    const s = await stat(path)
    const mode = s.mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('validateConfig', () => {
  it('throws BurstSetupError for missing region', () => {
    const cfg = { region: '' } as Config
    expect(() => validateConfig(cfg)).toThrow(BurstSetupError)
  })

  it('throws for missing s3Bucket', () => {
    const cfg = {
      region: 'us-east-1',
      s3Bucket: '',
      ecrBaseUri: 'x',
      executionRoleArn: 'y',
      taskRoleArn: 'z',
    } as unknown as Config
    expect(() => validateConfig(cfg)).toThrow(BurstSetupError)
  })

  it('passes for valid config', () => {
    const cfg = {
      region: 'us-east-1',
      s3Bucket: 'my-bucket',
      ecrBaseUri: '123.dkr.ecr.us-east-1.amazonaws.com',
      executionRoleArn: 'arn:aws:iam::123:role/exec',
      taskRoleArn: 'arn:aws:iam::123:role/task',
    } as unknown as Config
    expect(() => validateConfig(cfg)).not.toThrow()
  })
})
