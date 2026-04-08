# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-02

### Added

- `map()` top-level convenience function — drop-in cloud parallel map for TypeScript
- `Pool` class — caches worker image and bundle across repeated calls
- `Executor` class — core execution engine with `BurstOptions` interface
- `attach()` — connect to a running `DetachedSession` for async workflows
- `Session` — full 7-step worker lifecycle (task upload → ECS launch → poll → collect → cleanup)
- `DetachedSession` — `status()`, `collect()`, `cleanup()` for detached workflows
- esbuild bundle strategy — user function + all imports compiled to CJS bundle embedded in task file (no per-job Docker build for pure-JS functions)
- Binary task file format: `[4b bundle len][bundle bytes][4b items len][v8.serialize(items)]`
- `node:v8` structured-clone serialization for task payloads and results
- Native module detection — falls back to environment-specific Docker image when `.node` files are present
- Pre-built `burst-workers-typescript:base` worker image for pure-JS jobs
- Cost estimation and display matching ARCHITECTURE.md format
- `BurstOptions`: `workers`, `cpu`, `memory`, `backend`, `spot`, `maxCost`, `costAlert`, `timeout`, `region`, `signal`
- Error class hierarchy: `BurstError`, `BurstPartialError`, `BurstQuotaError`, `BurstCostLimitError`, `BurstTimeoutError`, `BurstSetupError`
- Config file at `~/.burst/config.json` (snake_case on disk, camelCase in TypeScript), `BURST_CONFIG_PATH` env override
- `stet` CLI: `setup`, `status`, `session list/status/cleanup`, `config show/set`, `version`
- Dual ESM/CJS build via tsup
- 70 unit tests, 7 test files

[0.1.0]: https://github.com/scttfrdmn/stet/releases/tag/v0.1.0
