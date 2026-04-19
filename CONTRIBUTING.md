# Contributing

## Local setup

```bash
bun install
./setup --server
```

Bridge operators also need:

- `gh` authenticated
- `ao` installed
- a GitHub App or PAT-based auth configuration

## Core commands

```bash
bun run test
bun run lint
bun run build
bun run bridge
```

## Current repo layout

```text
bin/
  webhook-bridge.ts        bridge entrypoint
  zapbot-team-init         repo onboarding helper

src/
  config/                  YAML + .env reload support
  github/                  GitHub auth/API wrapper
  http/                    HMAC verification and JSON error helpers
  logger.ts                logging

v2/
  ao/dispatcher.ts         direct ao spawn path
  bridge.ts                webhook handling + dispatch orchestration
  gateway.ts               gateway registration and webhook classification
  github-state.ts          GitHub-native issue reads
  mention-parser.ts        @zapbot command parsing
  moltzap/                 MoltZap runtime/session support

gateway/
  optional webhook proxy / bridge registry

test/
  unit and property tests for the current runtime
```

## What not to reintroduce

Do not add back:

- SQLite-backed workflow state
- internal agent team abstractions on top of `ao`
- workflow/history HTTP APIs that are no longer part of the shipped surface
- docs that describe deleted state-machine behavior as current

## Updating the bridge

1. Make the runtime change in `v2/` or `src/`.
2. Add or update tests under `test/`.
3. Run `bun run test`, `bun run lint`, and `bun run build`.
4. Keep README, ARCHITECTURE, and onboarding scripts aligned with the shipped path.
