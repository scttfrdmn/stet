import { describe, it, expect } from 'vitest'
import {
  serializeData,
  deserializeData,
  encodeTaskFile,
  decodeTaskFile,
  encodeResult,
  decodeResult,
} from '../../src/serialize.js'

describe('serializeData / deserializeData', () => {
  it('roundtrips primitives', () => {
    expect(deserializeData(serializeData(42))).toBe(42)
    expect(deserializeData(serializeData('hello'))).toBe('hello')
    expect(deserializeData(serializeData(true))).toBe(true)
    expect(deserializeData(serializeData(null))).toBeNull()
  })

  it('roundtrips Date', () => {
    const d = new Date('2026-03-15T00:00:00Z')
    const result = deserializeData(serializeData(d))
    expect(result).toBeInstanceOf(Date)
    expect((result as Date).getTime()).toBe(d.getTime())
  })

  it('roundtrips Map', () => {
    const m = new Map([['a', 1], ['b', 2]])
    const result = deserializeData(serializeData(m)) as Map<string, number>
    expect(result.get('a')).toBe(1)
    expect(result.get('b')).toBe(2)
  })

  it('roundtrips Set', () => {
    const s = new Set([1, 2, 3])
    const result = deserializeData(serializeData(s)) as Set<number>
    expect(result.has(2)).toBe(true)
    expect(result.size).toBe(3)
  })

  it('roundtrips TypedArray', () => {
    const arr = new Float64Array([1.1, 2.2, 3.3])
    const result = deserializeData(serializeData(arr)) as Float64Array
    expect(result[0]).toBeCloseTo(1.1)
    expect(result.length).toBe(3)
  })

  it('roundtrips nested objects', () => {
    const obj = { a: { b: { c: [1, 2, 3] } } }
    expect(deserializeData(serializeData(obj))).toEqual(obj)
  })
})

describe('encodeTaskFile / decodeTaskFile', () => {
  it('roundtrips bundle + items', () => {
    const bundle = Buffer.from('console.log("hello")')
    const items = [1, 2, 3, 'four']
    const encoded = encodeTaskFile(bundle, items)
    const { bundle: b2, items: i2 } = decodeTaskFile(encoded)
    expect(b2).toEqual(bundle)
    expect(i2).toEqual(items)
  })

  it('stores bundle at correct byte offset', () => {
    const bundle = Buffer.from('BUNDLE_CONTENT')
    const items = [42]
    const encoded = encodeTaskFile(bundle, items)
    // First 4 bytes = bundle length
    const bundleLen = encoded.readUInt32BE(0)
    expect(bundleLen).toBe(bundle.length)
    // Next bundleLen bytes = bundle content
    const extractedBundle = encoded.subarray(4, 4 + bundleLen)
    expect(Buffer.from(extractedBundle).toString()).toBe('BUNDLE_CONTENT')
  })

  it('handles empty items array', () => {
    const bundle = Buffer.from('code')
    const { items } = decodeTaskFile(encodeTaskFile(bundle, []))
    expect(items).toEqual([])
  })

  it('handles large bundles', () => {
    const bundle = Buffer.alloc(100_000, 0xab)
    const items = [{ x: 1 }, { x: 2 }]
    const { bundle: b2, items: i2 } = decodeTaskFile(encodeTaskFile(bundle, items))
    expect(b2.length).toBe(100_000)
    expect(i2).toEqual(items)
  })
})

describe('encodeResult / decodeResult', () => {
  it('roundtrips array of results', () => {
    const results = [1, 'two', { three: 3 }, null]
    expect(decodeResult(encodeResult(results))).toEqual(results)
  })

  it('roundtrips empty array', () => {
    expect(decodeResult(encodeResult([]))).toEqual([])
  })
})
