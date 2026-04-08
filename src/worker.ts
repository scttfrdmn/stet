/**
 * Self-contained ECS worker entrypoint.
 * Built into the pre-built burst-workers-typescript:base Docker image.
 * IMPORTANT: No imports from other stet modules — this file is standalone.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { serialize, deserialize } from 'node:v8'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const SESSION_ID = process.env['BURST_SESSION_ID']!
const TASK_ID = process.env['BURST_TASK_ID']!
const S3_BUCKET = process.env['BURST_S3_BUCKET']!
const REGION = process.env['BURST_REGION'] ?? 'us-east-1'

const s3 = new S3Client({ region: REGION })

function taskKey(suffix: string): string {
  return `sessions/${SESSION_ID}/tasks/${TASK_ID}.${suffix}`
}

async function getS3(key: string): Promise<Buffer> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  const chunks: Buffer[] = []
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function putS3(key: string, body: Buffer | string): Promise<void> {
  const buf = typeof body === 'string' ? Buffer.from(body) : body
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buf }))
}

function decodeTaskFile(buf: Buffer): { bundle: Buffer; items: unknown[] } {
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

async function main(): Promise<void> {
  await putS3(taskKey('status'), Buffer.from('running'))

  let bundlePath: string | null = null
  try {
    const taskBuf = await getS3(taskKey('task'))
    const { bundle, items } = decodeTaskFile(taskBuf)

    // Write bundle to temp file and require() it
    bundlePath = join(tmpdir(), `stet-worker-${SESSION_ID}-${TASK_ID}.cjs`)
    await writeFile(bundlePath, bundle)

    const require_ = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require_(bundlePath) as { __fn: (item: unknown) => unknown }

    const results = await Promise.all(items.map((item) => mod.__fn(item)))

    const resultBuf = serialize(results)
    await putS3(taskKey('result'), resultBuf)
    await putS3(taskKey('status'), Buffer.from('done'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await putS3(taskKey('error'), Buffer.from(msg))
    await putS3(taskKey('status'), Buffer.from('failed'))
    process.exit(1)
  } finally {
    if (bundlePath) {
      await unlink(bundlePath).catch(() => undefined)
    }
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal worker error: ${err}\n`)
  process.exit(1)
})
