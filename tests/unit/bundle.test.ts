import { describe, it, expect } from 'vitest'
import { bundleFunction, hashBuffer, detectNativeModules } from '../../src/bundle.js'
import { encodeTaskFile, decodeTaskFile } from '../../src/serialize.js'
import type { Metafile } from 'esbuild'

describe('hashBuffer', () => {
  it('returns 64-char hex string', () => {
    const hash = hashBuffer(Buffer.from('hello'))
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('same input → same hash', () => {
    expect(hashBuffer(Buffer.from('abc'))).toBe(hashBuffer(Buffer.from('abc')))
  })

  it('different input → different hash', () => {
    expect(hashBuffer(Buffer.from('abc'))).not.toBe(hashBuffer(Buffer.from('xyz')))
  })
})

describe('detectNativeModules', () => {
  it('returns false for no .node files', () => {
    const meta: Metafile = {
      inputs: {},
      outputs: {
        'out.js': {
          bytes: 100,
          inputs: { 'src/index.js': { bytesInOutput: 100 } },
          imports: [],
          exports: [],
          entryPoint: 'src/index.js',
        },
      },
    }
    expect(detectNativeModules(meta)).toBe(false)
  })

  it('returns true when .node in inputs', () => {
    const meta: Metafile = {
      inputs: {},
      outputs: {
        'out.js': {
          bytes: 100,
          inputs: { 'native/addon.node': { bytesInOutput: 0 } },
          imports: [],
          exports: [],
          entryPoint: 'src/index.js',
        },
      },
    }
    expect(detectNativeModules(meta)).toBe(true)
  })

  it('returns true when .node in imports', () => {
    const meta: Metafile = {
      inputs: {},
      outputs: {
        'out.js': {
          bytes: 100,
          inputs: {},
          imports: [{ path: 'native/module.node', kind: 'require-call', external: true }],
          exports: [],
          entryPoint: 'src/index.js',
        },
      },
    }
    expect(detectNativeModules(meta)).toBe(true)
  })
})

describe('bundleFunction', () => {
  it('bundles a simple arrow function', async () => {
    const fn = (x: number) => x * 2
    const result = await bundleFunction(fn)
    expect(result.bundle).toBeInstanceOf(Buffer)
    expect(result.bundle.length).toBeGreaterThan(0)
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.hasNativeModules).toBe(false)
  }, 15000)

  it('produces require()-able CJS bundle', async () => {
    const fn = (x: number) => x + 10
    const result = await bundleFunction(fn)

    // Write bundle to temp file and test it
    const { writeFile, unlink } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createRequire } = await import('node:module')

    const path = join(tmpdir(), `stet-bundle-test-${Date.now()}.cjs`)
    await writeFile(path, result.bundle)
    try {
      const require_ = createRequire(import.meta.url)
      const mod = require_(path) as { __fn: (x: number) => number }
      expect(mod.__fn(5)).toBe(15)
    } finally {
      await unlink(path).catch(() => undefined)
    }
  }, 15000)

  it('bundle embedded in task file decodes correctly', async () => {
    const fn = (x: number) => x * 3
    const result = await bundleFunction(fn)
    const taskBuf = encodeTaskFile(result.bundle, [1, 2, 3])
    const { bundle, items } = decodeTaskFile(taskBuf)
    expect(bundle.equals(result.bundle)).toBe(true)
    expect(items).toEqual([1, 2, 3])
  }, 15000)
})
