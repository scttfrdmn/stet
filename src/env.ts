import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  ECRClient,
  DescribeImagesCommand,
  RepositoryNotFoundException,
  ImageNotFoundException,
} from '@aws-sdk/client-ecr'
import type { Config } from './config.js'
import type { BundleResult } from './bundle.js'
import { BurstSetupError } from './errors.js'

const BASE_IMAGE_TAG = 'base'
const BASE_REPO_NAME = 'burst-workers-typescript'

async function imageExists(
  ecr: ECRClient,
  repositoryName: string,
  imageTag: string,
): Promise<string | null> {
  try {
    const resp = await ecr.send(
      new DescribeImagesCommand({
        repositoryName,
        imageIds: [{ imageTag }],
      }),
    )
    const detail = resp.imageDetails?.[0]
    return detail ? `${repositoryName}:${imageTag}` : null
  } catch (err) {
    if (
      err instanceof RepositoryNotFoundException ||
      err instanceof ImageNotFoundException ||
      (err as { name?: string }).name === 'ImageNotFoundException' ||
      (err as { name?: string }).name === 'RepositoryNotFoundException'
    ) {
      return null
    }
    throw err
  }
}

function ecrUri(cfg: Config, repositoryName: string, tag: string): string {
  return `${cfg.ecrBaseUri}/${repositoryName}:${tag}`
}

async function runBurstCore(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('burst-core', args, { stdio: 'inherit' })
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`burst-core exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}

export async function resolveWorkerImage(
  bundleResult: BundleResult,
  cfg: Config,
): Promise<string> {
  const ecr = new ECRClient({ region: cfg.region })

  if (!bundleResult.hasNativeModules) {
    // Pure-JS path: check for pre-built base image
    const uri = await imageExists(ecr, BASE_REPO_NAME, BASE_IMAGE_TAG)
    if (!uri) {
      throw new BurstSetupError(
        'image',
        `Base worker image ${BASE_REPO_NAME}:${BASE_IMAGE_TAG} not found in ECR`,
        "Run 'stet setup' to provision base worker image",
      )
    }
    return ecrUri(cfg, BASE_REPO_NAME, BASE_IMAGE_TAG)
  }

  // Native-module path: use package-lock.json hash
  process.stderr.write(
    '⚠ Native modules detected — using environment-specific worker image\n',
  )

  const envHash = await getNativeEnvHash()
  const repoName = BASE_REPO_NAME
  const existing = await imageExists(ecr, repoName, envHash)
  if (existing) {
    return ecrUri(cfg, repoName, envHash)
  }

  // Build native image via burst-core
  const dockerfilePath = join(process.cwd(), 'Dockerfile.worker.native')
  await runBurstCore([
    'image',
    'build',
    '--lang',
    'typescript',
    '--env-hash',
    envHash,
    '--dockerfile',
    dockerfilePath,
  ])

  return ecrUri(cfg, repoName, envHash)
}

async function getNativeEnvHash(): Promise<string> {
  const lockPath = join(process.cwd(), 'package-lock.json')
  if (existsSync(lockPath)) {
    const content = await readFile(lockPath)
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }
  // Fallback: hash package.json
  const pkgPath = join(process.cwd(), 'package.json')
  if (existsSync(pkgPath)) {
    const content = await readFile(pkgPath)
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }
  return 'unknown'
}
