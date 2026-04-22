# Zapbot Architecture

zapbot is a thin bridge around `ao`.

It does not own durable workflow state, task retries, agent teams, or an
internal state machine. Those older surfaces have been removed from the shipped
runtime. The live path is GitHub webhook intake plus a persistent AO
orchestrator control loop.

## Runtime shape

```text
GitHub issue_comment webhook
  -> HMAC verify
  -> mention classification
  -> permission check
  -> ensure orchestrator session exists (`ao start` / `ao status`)
  -> ao send raw GitHub control prompt
  -> orchestrator decides whether to spawn workers via
     `bun run bin/ao-spawn-with-moltzap.ts <issue-number>`
  -> worker plugin boots Claude + local MoltZap channel runtime
```

Plain-language boundary split:

- The bridge verifies GitHub input and forwards only allowed control events.
- The orchestrator is the one persistent per-project session that decides
  whether more work is needed.
- Workers are disposable task sessions; they do not own project lifecycle.
- The lifecycle registry is the ownership ledger that decides which sessions
  zapbot may reuse, stop, or garbage-collect.

## Key modules

| Path | Purpose |
|---|---|
| `src/gateway.ts` | gateway registration + webhook verification/classification |
| `src/mention-parser.ts` | parse literal `@zapbot ...` commands from issue comments |
| `src/bridge.ts` | HTTP request handling and orchestrator forwarding |
| `src/orchestrator/control-event.ts` | render GitHub control input into the orchestrator prompt |
| `src/orchestrator/runtime.ts` | ensure the persistent orchestrator exists and forward prompts via `ao send` |
| `src/lifecycle/` | managed-session registry, ownership controller, GC planning, lifecycle command model |
| `bin/resolve-managed-startup-retry.ts` | startup helper that decides whether duplicate-session retry is allowed |
| `bin/ao-spawn-with-moltzap.ts` | worker spawn helper that preserves MoltZap control linkage |
| `worker/ao-plugin-agent-claude-moltzap/` | repo-local Claude/MoltZap AO agent plugin |
| `src/moltzap/runtime.ts` | decode zapbot MoltZap config and provision `MOLTZAP_*` child env |
| `src/moltzap/session-client.ts` | load worker-side MoltZap env inside AO sessions |
| `src/moltzap/channel-runtime.ts` | bind the MoltZap session client to the Claude channel runtime |
| `src/github-state.ts` | GitHub-native issue state reads |
| `bin/webhook-bridge.ts` | entrypoint: load config, boot bridge, install reload/shutdown hooks |

## Error model

The live modules use tagged errors and `Result<T, E>` across module boundaries.

Current bridge-visible control-path failures:

| Tag | Meaning |
|---|---|
| `AoStartFailed` | zapbot could not start the project orchestrator |
| `OrchestratorNotFound` | no orchestrator session was visible for the configured project |
| `OrchestratorNotReady` | the orchestrator session exists but has not published the required metadata yet |
| `AoSendFailed` | forwarding the GitHub control prompt into the orchestrator failed |
| `ProjectNotConfigured` | the repo is not routed in zapbot config |

Worker-side spawn failures remain local to the orchestrator/worker lane:

| Tag | Meaning |
|---|---|
| `AoSpawnFailed` | the helper could not spawn a worker session |
| `MoltzapProvisionFailed` | zapbot could not provision MoltZap env for the child session |

## MoltZap boundary

zapbot does not implement a MoltZap server and does not become the agent
runtime. Its responsibility is narrower:

1. Decode `ZAPBOT_MOLTZAP_*` env at boot.
2. If configured, build `MOLTZAP_*` env for orchestrator and worker sessions.
3. Optionally register a fresh MoltZap agent per worker dispatch when a
   registration secret is available.

The worker plugin and local Claude channel runtime are responsible for actually
using those credentials.

## Managed session ownership

Lifecycle ownership is explicit, not inferred from names.

- Each project keeps a local `.zapbot-managed-sessions.json` registry beside
  `agent-orchestrator.yaml`.
- `src/orchestrator/runtime.ts` only resolves a reusable orchestrator session if
  there is a matching zapbot-managed orchestrator record in that registry.
- `bin/ao-spawn-with-moltzap.ts` upserts worker records with `scope: "worker"`
  and `origin: "ao-spawn-with-moltzap.ts"` once worker metadata exposes the
  `worktree` and `tmuxName`.
- `src/lifecycle/gc.ts` only plans or removes stale records that are explicitly
  tagged `managed: true` and `owner: "zapbot"`.
- Manual or pre-existing tmux sessions that are not in the registry are out of
  scope for automation.
- The registry is a local operator ledger, not an authentication boundary. Use
  it to decide what zapbot owns, then confirm live runtime state with `ao
  status` before touching a session by hand.

## Reload and shutdown

- `SIGHUP` re-reads `.env` and `agent-orchestrator.yaml`, rebuilds `BridgeConfig`,
  and re-registers bridge routes with the gateway.
- `SIGINT` / `SIGTERM` stop the HTTP server and deregister bridge routes.
- `start.sh` duplicate-session retry is lifecycle-gated: it may stop only a
  matching managed orchestrator record, never a session chosen by tmux-name
  heuristic.
- The current operator floor is: use the registry to decide what is safe to
  inspect or clean up, and leave anything outside that registry alone.
- GitHub comment intake is still permission-gated at the bridge layer before a
  control event reaches the orchestrator.
