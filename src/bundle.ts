import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Metafile } from 'esbuild'

export interface BundleResult {
  bundle: Buffer
  hash: string
  hasNativeModules: boolean
}

export function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export function detectNativeModules(metafile: Metafile): boolean {
  for (const output of Object.values(metafile.outputs)) {
    const inputs = Object.keys(output.inputs ?? {})
    if (inputs.some((p) => p.endsWith('.node'))) return true
  }
  // Also check imports in outputs
  for (const output of Object.values(metafile.outputs)) {
    const imports = output.imports ?? []
    if (imports.some((imp) => imp.path.endsWith('.node'))) return true
  }
  return false
}

export async function bundleFunction(fn: Function): Promise<BundleResult> {
  const esbuild = await import('esbuild')

  const fnSource = fn.toString()
  const tempDir = await mkdtemp(join(tmpdir(), 'stet-bundle-'))

  try {
    const entryPath = join(tempDir, 'entry.ts')
    const outPath = join(tempDir, 'worker.bundle.cjs')

    // Wrap function in a module export the worker can require()
    const entryContent = `
const __fn = ${fnSource};
module.exports = { __fn };
`
    await writeFile(entryPath, entryContent)

    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile: outPath,
      metafile: true,
      logLevel: 'silent',
    })

    const bundleContent = await readFile(outPath)
    const bundle = Buffer.from(bundleContent)
    const hash = hashBuffer(bundle)
    const hasNativeModules = detectNativeModules(result.metafile!)

    return { bundle, hash, hasNativeModules }
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}
