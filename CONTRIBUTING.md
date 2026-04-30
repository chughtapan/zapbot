# Contributing

## Local setup

```bash
bash scripts/bootstrap-moltzap.sh
bun install
```

`scripts/bootstrap-moltzap.sh` initialises the `vendor/moltzap` git
submodule, runs `pnpm install --prefer-frozen-lockfile` + `pnpm --filter
"@moltzap/claude-code-channel..." --filter "@moltzap/app-sdk..." build`
inside it, and rewrites `workspace:*` specifiers so bun can resolve the
`file:./vendor/moltzap/packages/*` deps at `bun install` time. It is
idempotent: the build step skips if every required `dist/index.js`
already exists. The sbd#200 MoltZap rework added `@moltzap/app-sdk` to
the build set — the bridge owns `MoltZapApp` lifecycle and imports the
SDK directly.

Prerequisites: `pnpm` on `PATH` (install once via `npm i -g pnpm` or
`corepack enable`). CI invokes the bootstrap script before `bun install`
automatically.

Bridge operators also need:

- `gh` authenticated
- `claude` CLI on `PATH` (the orchestrator resumes Claude Code sessions via
  `claude -p --resume`)
- `tmux` and `jq` on `PATH`
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
  zapbot-orchestrator.ts   orchestrator entrypoint (HTTP /turn listener)
  zapbot-spawn-mcp.ts      MCP server backing request_worker_spawn

src/
  bridge.ts                webhook handling + /turn dispatch
  config/                  YAML + .env load/reload support
  github/                  GitHub auth/API wrapper
  http/                    HMAC verification and JSON error helpers
  orchestrator/            HTTP server + claude-runner + spawn-broker
  moltzap/                 MoltZap runtime/session support

gateway/
  optional webhook proxy / bridge registry

test/
  unit and property tests for the current runtime
```

## What not to reintroduce

Do not add back:

- SQLite-backed workflow state
- internal agent team abstractions on top of the orchestrator
- workflow/history HTTP APIs that are no longer part of the shipped surface
- docs that describe deleted state-machine behavior as current
- AO (`@aoagents/ao`) as a worker spawn channel — the orchestrator +
  `@moltzap/runtimes` is the only worker spawn path

## Updating the bridge

1. Make the runtime change in `src/` (the bridge, orchestrator, and
   moltzap-side modules — `worker/` no longer exists).
2. Add or update tests under `test/`.
3. Run `bun run test`, `bun run lint`, and `bun run build`.
4. Keep README, ARCHITECTURE, and onboarding scripts aligned with the shipped path.
