import { parseArgs } from 'node:util'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const VERSION = '0.1.0'

function requireBurstCore(): void {
  const paths = (process.env['PATH'] ?? '').split(':')
  const found = paths.some((p) => existsSync(join(p, 'burst-core')))
  if (!found) {
    process.stderr.write("Error: 'burst-core' not found in PATH\n")
    process.stderr.write("Install burst-core: https://github.com/scttfrdmn/burst-core\n")
    process.exit(1)
  }
}

function burstCore(args: string[]): void {
  requireBurstCore()
  execFileSync('burst-core', args, { stdio: 'inherit' })
}

function printHelp(): void {
  process.stdout.write(`stet v${VERSION} — cloud bursting for TypeScript

Usage:
  stet setup                      Provision AWS infrastructure
  stet status                     Show burst cluster status
  stet session list               List active sessions
  stet session status <id>        Show session status
  stet session cleanup <id>       Clean up session resources
  stet config show                Show current config
  stet config set <key> <value>   Set a config value
  stet version                    Print version

Options:
  --help     Show this help
  --version  Print version
`)
}

async function cmdSetup(positionals: string[]): Promise<void> {
  burstCore(['setup', ...positionals])
}

async function cmdStatus(positionals: string[]): Promise<void> {
  burstCore(['status', ...positionals])
}

async function cmdSession(positionals: string[]): Promise<void> {
  const [sub, ...rest] = positionals
  switch (sub) {
    case 'list':
      burstCore(['session', 'list', ...rest])
      break
    case 'status':
      if (!rest[0]) {
        process.stderr.write('Usage: stet session status <session-id>\n')
        process.exit(1)
      }
      burstCore(['session', 'status', ...rest])
      break
    case 'cleanup':
      if (!rest[0]) {
        process.stderr.write('Usage: stet session cleanup <session-id>\n')
        process.exit(1)
      }
      burstCore(['session', 'cleanup', ...rest])
      break
    default:
      process.stderr.write(`Unknown session subcommand: ${sub}\n`)
      process.stderr.write('Use: list, status, cleanup\n')
      process.exit(1)
  }
}

async function cmdConfig(positionals: string[]): Promise<void> {
  const [sub, key, value] = positionals
  const { loadConfig, saveConfig } = await import('./config.js')
  const cfg = await loadConfig()

  switch (sub) {
    case 'show':
      process.stdout.write(JSON.stringify(cfg, null, 2) + '\n')
      break
    case 'set':
      if (!key || value === undefined) {
        process.stderr.write('Usage: stet config set <key> <value>\n')
        process.exit(1)
      }
      ;(cfg as unknown as Record<string, unknown>)[key] = value
      await saveConfig(cfg)
      process.stdout.write(`Set ${key} = ${value}\n`)
      break
    default:
      process.stderr.write(`Unknown config subcommand: ${sub}\n`)
      process.exit(1)
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
    allowPositionals: true,
    strict: false,
  })

  if (values['version']) {
    process.stdout.write(`stet v${VERSION}\n`)
    return
  }

  if (values['help'] || positionals.length === 0) {
    printHelp()
    return
  }

  const [cmd, ...rest] = positionals

  switch (cmd) {
    case 'setup':
      await cmdSetup(rest)
      break
    case 'status':
      await cmdStatus(rest)
      break
    case 'session':
      await cmdSession(rest)
      break
    case 'config':
      await cmdConfig(rest)
      break
    case 'version':
      process.stdout.write(`stet v${VERSION}\n`)
      break
    default:
      process.stderr.write(`Unknown command: ${cmd}\n`)
      printHelp()
      process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
