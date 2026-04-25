# Integration test suite

Tests in this directory run against a live MoltZap server subprocess spawned by vitest's `globalSetup`.

## Pre-requisites

Build the vendored MoltZap server once:

```bash
cd vendor/moltzap
pnpm install --frozen-lockfile
pnpm -r build
cd ../..
```

The globalSetup checks for `vendor/moltzap/packages/server/dist/standalone.js` and fails fast with `StandaloneBinaryMissing` if it is absent.

## Running the suite

```bash
bunx vitest run --config test/integration/vitest.integration.config.ts
```

## What the suite expects

| Resource | Detail |
|---|---|
| MoltZap server | Spawned by `globalSetup.ts` at `localhost:41990` |
| Database | Embedded PGlite (`MOLTZAP_DEV_MODE=true`, no external Postgres) |
| Agent registration | Open (no server-side registration secret) |
| Encryption | 32-byte base64 key generated at suite start |
| Server config | Temporary YAML written to `$TMPDIR/moltzap-test-<pid>.yaml` |

## Boot time

The server takes ~12–15 s to start (cold PGlite WASM load). The `BOOT_TIMEOUT_MS` in `globalSetup.ts` is 25 s. This cost is paid once per `vitest run` invocation, amortised across all test files.

## Test isolation

- `fileParallelism: false` — test files run sequentially against the shared server.
- Each test file boots its own bridge instance (`bootBridgeApp`) in `beforeAll` and shuts it down in `afterAll`.
- Agent names are prefixed per file (e.g., `roster-`, `rolepair-`) to avoid conflicts.
- The server's PGlite database is NOT reset between test files; agent names accumulate across the suite run.

## Architecture anchors

- Spike B verdict (sbd#182): subprocess spawn pattern, boot time measurement, health-poll approach.
- Architect rev 4 §7.6 (sbd#199 issue comment): integration test strategy.
- sbd#203: this work item.
