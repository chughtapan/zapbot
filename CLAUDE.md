# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Zapbot

zapbot is a thin GitHub webhook bridge that translates `@zapbot ...` mentions
into orchestrator turns. It does **not** own durable workflow state, retries,
agent-team abstractions, or an internal state machine — those legacy surfaces
were removed. The live path is:

- verify GitHub `issue_comment` webhooks (HMAC) and parse `@zapbot ...`
- check commenter write permission
- POST a `/turn` request to the persistent zapbot orchestrator process
- orchestrator resumes the project's lead Claude Code session
  (`claude -p --resume <id>`) inside `~/.zapbot/projects/<slug>/checkout/`
- the lead session calls the `request_worker_spawn` MCP tool to dispatch
  ephemeral workers via `@moltzap/runtimes` ClaudeCodeAdapter

See `ARCHITECTURE.md` for the module-level diagram and tagged-error catalog.

## GitHub comment commands

| Command | Effect |
|---|---|
| `@zapbot plan this` / `triage this` | turn dispatched to lead session |
| `@zapbot investigate` / `investigate this` | turn dispatched to lead session |
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
./start.sh .                              # moltzap-server + orchestrator + bridge
```

`start.sh` reads secrets from `~/.zapbot/config.json` (webhookSecret, apiKey,
orchestratorSecret) and project entries from `~/.zapbot/projects.json` (the
file `bin/zapbot-team-init` writes; loaded by `bin/zapbot-orchestrator.ts`).

## Layout

- `src/` — live runtime: `bridge.ts`, `mention-parser.ts`, `gateway.ts`,
  `orchestrator/` (HTTP server + claude-runner + spawn-broker + tagged
  errors), `moltzap/` (runtime config + session client + channel runtime),
  `config/`, `github/`, `http/`, `lifecycle/`, `startup/`
- `bin/webhook-bridge.ts` — bridge entrypoint
- `bin/zapbot-orchestrator.ts` — orchestrator entrypoint (HTTP `/turn`
  listener + claude session resume + spawn broker)
- `bin/zapbot-spawn-mcp.ts` — MCP server bin exposed to lead Claude
  sessions; backs the `request_worker_spawn` tool call
- `bin/zapbot-team-init` — writes `~/.zapbot/projects.json` entries and
  the canonical `~/.zapbot/config.json`
- `gateway/` — optional bridge registry / webhook proxy
- `vendor/moltzap/` — git submodule; built into `dist/` by `bootstrap-moltzap.sh`
- `test/` — vitest unit/property tests; `test/integration/**` is excluded from default runs

## Conventions

- **Bridge → orchestrator dispatch**: the bridge translates webhooks into
  POST `/turn` calls to the orchestrator process; the orchestrator owns
  Claude session resumption + MCP-mediated worker spawn via
  `@moltzap/runtimes`. The bridge does not import `@moltzap/runtimes` and
  does not spawn worker processes.
- **Error model**: tagged errors + `Result<T, E>` across module boundaries.
  Bridge-visible control-path tags include `OrchestratorUnreachable`,
  `OrchestratorAuthFailed`, `ProjectNotConfigured`. Orchestrator-side tags:
  `BootConfigInvalid`, `LeadSessionCorrupted`, `LeadProcessFailed`,
  `LockTimeout`, `GitFetchFailed`, `ProjectCheckoutFailed`,
  `McpConfigWriteFailed`, `FleetSpawnFailed`.
- **ESLint** uses `eslint-plugin-agent-code-guard`. Several rules are pinned to
  `warn` because of an in-flight Effect migration (see comments in
  `eslint.config.mjs`); do not add new violations to those categories, and do
  not silence the rules.
- **Reload/shutdown**: bridge `SIGHUP` re-reads `.env` and re-registers
  gateway routes; orchestrator `SIGHUP` re-reads `~/.zapbot/projects.json`
  and provisions any new project checkouts. `SIGINT`/`SIGTERM` deregister
  and stop both processes.
- **Trust boundary for orchestrator child processes**: zapbot forwards
  `GH_TOKEN` (the GitHub installation token) and `MOLTZAP_*` into spawned
  Claude lead/worker sessions. It does **not** forward `ZAPBOT_API_KEY`,
  `ZAPBOT_WEBHOOK_SECRET`, `ZAPBOT_ORCHESTRATOR_SECRET`, or
  `GITHUB_APP_PRIVATE_KEY`. Preserve this when touching env wiring.

## Do not reintroduce

These surfaces were intentionally removed; do not bring them back without an
explicit ask:

- SQLite-backed workflow state
- workflow/history HTTP APIs
- the static `ZAPBOT_MOLTZAP_API_KEY` mode (sbd#199 — registration secret is
  required whenever `ZAPBOT_MOLTZAP_SERVER_URL` is set)
- docs that describe deleted state-machine behavior as current
- AO (`@aoagents/ao`) as a worker spawn channel — the orchestrator +
  `@moltzap/runtimes` is the only worker spawn path
- `agent-orchestrator.yaml` as the bridge / project config source —
  `~/.zapbot/projects.json` is the single source of truth, written by
  `bin/zapbot-team-init` and read by `bin/zapbot-orchestrator.ts`
- repo-local AO plugins under `worker/` — those have been deleted
