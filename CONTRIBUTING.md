# Contributing

## Local setup

```bash
bun install
```

Bridge operators also need:

- `gh` authenticated
- `ao` installed
- a GitHub App or PAT-based auth configuration

Operator bootstrap flow:

```bash
cd /path/to/zapbot
./setup --server

cd /path/to/your-project
/path/to/zapbot/bin/zapbot-team-init owner/repo
/path/to/zapbot/start.sh .
```

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
  ao-spawn-with-moltzap.ts worker spawn helper

src/
  bridge.ts                webhook handling + orchestrator forwarding
  config/                  YAML + .env load/reload support
  github/                  GitHub auth/API wrapper
  http/                    HMAC verification and JSON error helpers
  orchestrator/            persistent AO orchestrator control path
  moltzap/                 MoltZap runtime/session support

worker/
  ao-plugin-agent-claude-moltzap/
                           repo-local Claude/MoltZap AO agent plugin

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

1. Make the runtime change in `src/` or `worker/`, whichever owns the live path.
2. Add or update tests under `test/`.
3. Run `bun run test`, `bun run lint`, and `bun run build`.
4. Keep README, ARCHITECTURE, and onboarding scripts aligned with the shipped path.
