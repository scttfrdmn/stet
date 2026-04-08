import { serialize, deserialize } from 'node:v8'

export function serializeData(data: unknown): Buffer {
  return serialize(data)
}

export function deserializeData(buf: Buffer): unknown {
  return deserialize(buf)
}

/**
 * Binary task file format:
 * [4 bytes: bundle length (big-endian uint32)]
 * [N bytes: worker.bundle.js content]
 * [4 bytes: items length (big-endian uint32)]
 * [M bytes: v8.serialize(items_chunk)]
 */
export function encodeTaskFile(bundle: Buffer, items: unknown[]): Buffer {
  const itemsBuf = serialize(items)

  const out = Buffer.allocUnsafe(4 + bundle.length + 4 + itemsBuf.length)
  let offset = 0

  out.writeUInt32BE(bundle.length, offset)
  offset += 4
  bundle.copy(out, offset)
  offset += bundle.length

  out.writeUInt32BE(itemsBuf.length, offset)
  offset += 4
  itemsBuf.copy(out, offset)

  return out
}

export function decodeTaskFile(buf: Buffer): { bundle: Buffer; items: unknown[] } {
  let offset = 0

  const bundleLen = buf.readUInt32BE(offset)
  offset += 4
  const bundle = buf.subarray(offset, offset + bundleLen)
  offset += bundleLen

  const itemsLen = buf.readUInt32BE(offset)
  offset += 4
  const itemsBuf = buf.subarray(offset, offset + itemsLen)

  const items = deserialize(itemsBuf) as unknown[]
  return { bundle: Buffer.from(bundle), items }
}

export function encodeResult(results: unknown[]): Buffer {
  return serialize(results)
}

export function decodeResult(buf: Buffer): unknown[] {
  return deserialize(buf) as unknown[]
}
