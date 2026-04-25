# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Zapbot

zapbot is a thin GitHub webhook bridge around `ao`. It does **not** own durable
workflow state, retries, agent-team abstractions, or an internal state machine —
those legacy surfaces were removed. The live path is:

- verify GitHub `issue_comment` webhooks (HMAC) and parse `@zapbot ...`
- check commenter write permission
- ensure the persistent AO orchestrator session exists for the project
- forward the raw GitHub control event into that orchestrator
- orchestrator decides whether to spawn workers via `bin/ao-spawn-with-moltzap.ts`
- optionally provision `MOLTZAP_*` env for orchestrator/worker sessions

See `ARCHITECTURE.md` for the module-level diagram and tagged-error catalog.

## GitHub comment commands

| Command | Effect |
|---|---|
| `@zapbot plan this` / `triage this` | spawn an `ao` session |
| `@zapbot investigate` / `investigate this` | spawn an `ao` session |
| `@zapbot status` | post a GitHub-native issue summary |

Only literal `@zapbot` prefixes are matched; raw comment text is never spliced
into a shell command.

## Commands

First-time clone — vendor submodule + workspace build is required before
`bun install` will resolve the `@moltzap/*` deps:

```bash
bash scripts/bootstrap-moltzap.sh   # idempotent; needs pnpm on PATH
bun install
```

Day-to-day:

```bash
bun run test                              # vitest run (excludes test/integration/**)
bunx vitest run test/<name>.test.ts       # single test file
bunx vitest run -t "<test name pattern>"  # single test by name
bun run lint                              # eslint (src, gateway/src, bin)
bun run build                             # tsc type-check
bun run bridge                            # bun run bin/webhook-bridge.ts (expects env)
./start.sh .                              # bridge + AO from a project checkout
```

`start.sh` requires `agent-orchestrator.yaml` in the project dir and reads
secrets from `~/.zapbot/config.json` (webhookSecret, apiKey).

## Layout

- `src/` — live runtime: `bridge.ts`, `mention-parser.ts`, `gateway.ts`,
  `orchestrator/` (control-event render + AO send/ensure), `moltzap/` (runtime
  config + session client + channel runtime), `config/`, `github/`, `http/`,
  `ao/`, `lifecycle/`, `startup/`
- `bin/webhook-bridge.ts` — bridge entrypoint
- `bin/ao-spawn-with-moltzap.ts` — worker spawn helper that preserves MoltZap linkage
- `worker/ao-plugin-agent-claude-moltzap/` — repo-local Claude/MoltZap AO agent plugin
- `gateway/` — optional bridge registry / webhook proxy
- `vendor/moltzap/` — git submodule; built into `dist/` by `bootstrap-moltzap.sh`
- `test/` — vitest unit/property tests; `test/integration/**` is excluded from default runs

## Conventions

- **Error model**: tagged errors + `Result<T, E>` across module boundaries.
  Bridge-visible control-path tags include `AoStartFailed`,
  `OrchestratorNotFound`, `OrchestratorNotReady`, `AoSendFailed`,
  `ProjectNotConfigured`. Worker-spawn lane: `AoSpawnFailed`,
  `MoltzapProvisionFailed`.
- **ESLint** uses `eslint-plugin-agent-code-guard`. Several rules are pinned to
  `warn` because of an in-flight Effect migration (see comments in
  `eslint.config.mjs`); do not add new violations to those categories, and do
  not silence the rules.
- **Reload/shutdown**: `SIGHUP` re-reads `.env` + `agent-orchestrator.yaml`
  and re-registers gateway routes; `SIGINT`/`SIGTERM` deregister and stop.
- **Trust boundary for AO child processes**: zapbot forwards `GH_TOKEN` (the
  GitHub installation token) and `MOLTZAP_*` into spawned AO sessions. It
  does **not** forward `ZAPBOT_API_KEY`, `ZAPBOT_WEBHOOK_SECRET`, or
  `GITHUB_APP_PRIVATE_KEY`. Preserve this when touching env wiring.

## Do not reintroduce

These surfaces were intentionally removed; do not bring them back without an
explicit ask:

- SQLite-backed workflow state
- internal agent-team abstractions on top of `ao`
- workflow/history HTTP APIs
- the static `ZAPBOT_MOLTZAP_API_KEY` mode (sbd#199 — registration secret is
  required whenever `ZAPBOT_MOLTZAP_SERVER_URL` is set)
- docs that describe deleted state-machine behavior as current
