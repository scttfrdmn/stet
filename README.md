# stet

Cloud bursting for TypeScript — AWS parallel map.

`stet` is part of the [burst family](https://github.com/scttfrdmn/burst-core) of cloud-bursting libraries. It offloads parallel work to AWS ECS/Fargate workers with a single function call.

```typescript
import { map } from 'stet'

// Run 1000 items in parallel on Fargate — change one line
const results = await map(items, x => expensiveCompute(x), { workers: 50 })
```

## Key Innovation

For pure TypeScript/JavaScript functions, `stet` uses **esbuild** to bundle your function and all its imports into a single CJS bundle. This bundle is embedded directly in the task file alongside your data — no per-job Docker build. The pre-built `burst-workers-typescript:base` image handles all pure-JS jobs instantly.

## Requirements

- Node.js ≥ 20
- [burst-core](https://github.com/scttfrdmn/burst-core) CLI in PATH
- AWS credentials (via environment or `~/.aws/credentials`)

## Installation

```bash
npm install stet
```

## Usage

### Top-level `map()`

```typescript
import { map } from 'stet'

const results = await map([1, 2, 3, 4, 5], x => x * x, {
  workers: 5,
  cpu: 1,
  memory: '2GB',
})
// [1, 4, 9, 16, 25]
```

### `Pool` — reuse image and bundle

```typescript
import { Pool } from 'stet'

const pool = new Pool({ workers: 10 })
const resultsA = await pool.map(itemsA, processItem)
const resultsB = await pool.map(itemsB, processItem)  // reuses cached bundle
await pool.shutdown()
```

### `Executor` — full control

```typescript
import { Executor } from 'stet'

const exec = new Executor({ workers: 20, cpu: 2, memory: '4GB', timeout: 300 })
const results = await exec.map(fn, items)
await exec.shutdown()
```

### Async workflows with `attach()`

```typescript
import { attach } from 'stet'

// In another process / later:
const ds = await attach('ts-20260315-aabbccdd')
const status = await ds.status()
const results = await ds.collect()
await ds.cleanup()
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `workers` | `number` | config `defaultWorkers` | Number of Fargate workers |
| `cpu` | `number` | config `defaultCpu` | vCPUs per worker |
| `memory` | `string` | config default | Memory per worker (`"2GB"`, `"512MB"`) |
| `backend` | `'fargate' \| 'ec2'` | `'fargate'` | Launch type |
| `spot` | `boolean` | `false` | Use Spot capacity |
| `maxCost` | `number` | — | Abort if estimated cost exceeds limit ($) |
| `costAlert` | `number` | — | Print warning when cost approaches threshold |
| `timeout` | `number` | — | Timeout in seconds |
| `region` | `string` | config region | AWS region override |
| `signal` | `AbortSignal` | — | Cancellation signal |

## Setup

```bash
# Install burst-core and configure AWS infrastructure
burst-core setup

# Or use the stet CLI
stet setup
```

## Error Classes

```typescript
import {
  BurstError,
  BurstPartialError,   // some tasks failed — .results, .errors
  BurstQuotaError,     // Fargate vCPU quota exceeded
  BurstCostLimitError, // estimated cost > maxCost
  BurstTimeoutError,   // timeout expired
  BurstSetupError,     // AWS infrastructure not configured
} from 'stet'
```

## Native Module Support

If your function imports native `.node` modules, `stet` automatically detects this and builds an environment-specific worker image using `burst-core image build`. A warning is printed:

```
⚠ Native modules detected — using environment-specific worker image
```

## License

MIT
