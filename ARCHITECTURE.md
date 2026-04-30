# Zapbot Architecture

zapbot is a thin webhook bridge in front of a long-lived Claude Code session
per project, mediated by an orchestrator process. It does not own durable
workflow state, task retries, agent teams, or an internal state machine —
those older surfaces were removed from the shipped runtime.

## Topology

```text
                                  Project: chughtapan/zapbot
GitHub @zapbot mention             ┌──────────────────────────────────────────┐
        │                          │ LEAD SESSION (Claude Code, headless)     │
        ▼                          │                                          │
    bridge                         │ Per-project state at:                    │
    (HMAC verify,                  │   ~/.zapbot/projects/<slug>/             │
     mention parse,                │     session.json   (resumed across runs) │
     install token,                │     checkout/      (project worktree)    │
     translates to                 │     .mcp.json      (spawn-worker tool)   │
     conversation turn)            │                                          │
        │                          │ Each webhook becomes:                    │
        │   POST /turn              │   claude -p --resume <id> "<message>"   │
        └──────────────────────────►   invoked by orchestrator, captures      │
                                   │   stdout, persists new session_id        │
                                   │                                          │
                                   │ Inside the claude session:               │
                                   │   • read repo via built-in tools         │
                                   │   • use request_worker_spawn MCP tool    │
                                   │     when work is parallel / isolated     │
                                   │   • post results to GitHub via gh CLI    │
                                   └────────────┬─────────────────────────────┘
                                                │ MCP request_worker_spawn
                                                ▼
                                   ┌──────────────────────────────────────────┐
                                   │ ORCHESTRATOR (Effect-native)             │
                                   │                                          │
                                   │ Owns:                                    │
                                   │  - POST /turn  (bridge → claude-runner)  │
                                   │  - MCP server: request_worker_spawn      │
                                   │  - claude session-id persistence         │
                                   │  - @moltzap/runtimes spawn delegation    │
                                   │                                          │
                                   │ The ONLY process that touches            │
                                   │ RuntimeFleet/startRuntimeAgent directly. │
                                   └────────────┬─────────────────────────────┘
                                                │ startRuntimeAgent (claude-code adapter)
                                                ▼
                                   ephemeral worker Claude session
                                   (per task, in a worktree;
                                    exits when done; writes back to
                                    GitHub directly via gh CLI)
                                                │
                                                ▼
                                   GitHub (issue comments / PRs / commits)
                                                │
                                                ▼
                                   another @zapbot webhook fires
                                   ↑ flow loops back to top
```

## Key modules

| Path | Purpose |
|---|---|
| `src/gateway.ts` | gateway registration + webhook verification/classification |
| `src/mention-parser.ts` | parse literal `@zapbot ...` commands from issue comments |
| `src/bridge.ts` | HTTP request handling + orchestrator `/turn` dispatch |
| `src/bridge-process.ts` | bridge lifecycle (SIGHUP/SIGINT/SIGTERM, reload state machine) |
| `bin/webhook-bridge.ts` | bridge entrypoint: load config, boot bridge |
| `src/orchestrator/runner.ts` | per-project lock + claude session resume invoker |
| `src/orchestrator/server.ts` | orchestrator HTTP `/turn` listener |
| `src/orchestrator/spawn-broker.ts` | Effect-native wrapper around `@moltzap/runtimes.startRuntimeAgent` |
| `src/orchestrator/errors.ts` | `OrchestratorError` tagged-error catalog |
| `bin/zapbot-orchestrator.ts` | orchestrator entrypoint: config, project provisioning, MCP server, HTTP listener |
| `bin/zapbot-spawn-mcp.ts` | MCP bin exposed to lead claude sessions; calls back into the orchestrator |
| `bin/zapbot-team-init` | writes `~/.zapbot/projects.json` + `~/.zapbot/config.json` |
| `src/moltzap/runtime.ts` | decode zapbot MoltZap config and provision `MOLTZAP_*` child env |
| `src/moltzap/session-client.ts` | load worker-side MoltZap env inside claude sessions |
| `src/moltzap/channel-runtime.ts` | bind the MoltZap session client to the Claude channel runtime |
| `src/github-state.ts` | GitHub-native issue state reads |

## Project-state directory layout

```
~/.zapbot/
├── config.json              # webhookSecret, apiKey, orchestratorSecret
├── projects.json            # { "<slug>": { repo, defaultBranch } }
├── clones/<slug>.git/       # bare clone (object DB shared with worktree)
└── projects/<slug>/
    ├── checkout/            # working tree, fast-forwarded each turn
    ├── session.json         # { currentSessionId, lastTurnAt, lastDeliveryId }
    ├── .mcp.json            # spawn-worker MCP server config for the lead
    ├── lock                 # advisory file lock (stamped with PID)
    └── logs/turn-<deliveryId>.log   # captured claude -p stdout/stderr per turn
```

`session.json` is schema-validated by `SessionFileSchema` in
`src/orchestrator/runner.ts`; on a parse failure the runner moves it aside as
`session.json.corrupt-<unix-ms>` and the next turn starts fresh. `lastDeliveryId`
makes redelivery of the same GitHub `X-GitHub-Delivery` header idempotent.

`projects.json` is written by `bin/zapbot-team-init` and read by
`bin/zapbot-orchestrator.ts`'s `ProjectsFileSchema`. The shape is:

```json
{
  "<slug>": { "repo": "owner/name", "defaultBranch": "main" }
}
```

## Error model

The live modules use tagged errors and `Result<T, E>` across module boundaries.

Bridge → orchestrator dispatch failures:

| Tag | Meaning |
|---|---|
| `OrchestratorUnreachable` | the bridge could not connect to the orchestrator's `/turn` endpoint |
| `OrchestratorAuthFailed` | the orchestrator rejected the bridge's shared-secret bearer |
| `ProjectNotConfigured` | the repo is not routed in zapbot config |

Orchestrator-side failures:

| Tag | Meaning |
|---|---|
| `BootConfigInvalid` | `config.json`, `projects.json`, or vendor/moltzap path resolution failed at boot |
| `LeadSessionCorrupted` | `session.json` is unreadable / writable failure (stashed for operator inspection) |
| `LeadProcessFailed` | the resumed `claude -p` subprocess exited non-zero or could not start |
| `LockTimeout` | another in-flight turn for the project held the advisory lock past the deadline |
| `GitFetchFailed` | `git fetch` / `git pull --ff-only` failed against the project worktree |
| `ProjectCheckoutFailed` | initial bare-clone + worktree provisioning failed |
| `McpConfigWriteFailed` | could not write `.mcp.json` for the lead session |
| `FleetSpawnFailed` | `@moltzap/runtimes.startRuntimeAgent` rejected the worker spawn |

## MoltZap boundary

zapbot does not implement a MoltZap server and does not become the agent
runtime. Its responsibility is narrower:

1. Decode `ZAPBOT_MOLTZAP_*` env at boot.
2. If configured, build `MOLTZAP_*` env for the orchestrator and worker
   sessions.
3. Optionally register a fresh MoltZap agent per worker dispatch when a
   registration secret is available.

The lead/worker sessions and their local Claude channel runtimes are
responsible for actually using those credentials.

## Reload and shutdown

- **Bridge `SIGHUP`** re-reads `.env`, rebuilds `BridgeRuntimeConfig`, and
  re-registers gateway routes.
- **Orchestrator `SIGHUP`** re-reads `~/.zapbot/projects.json` and runs
  `ensureProjectCheckout` for any new project entries (no-op for known
  ones).
- **Bridge `SIGINT` / `SIGTERM`** stop the HTTP server and deregister
  bridge routes.
- **Orchestrator `SIGINT` / `SIGTERM`** close the HTTP server, then call
  `broker.stopAll()` to tear down the runtime fleet, then exit.
