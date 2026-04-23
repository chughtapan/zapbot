# Zapbot Architecture

zapbot is a thin bridge around `ao`.

It does not own durable workflow state, task retries, agent teams, or an
internal state machine. Those older surfaces have been removed from the shipped
runtime. The live path is GitHub webhook intake plus a persistent AO
orchestrator control loop.

## Runtime shape

```text
GitHub issue_comment webhook
  -> validate configured GitHub webhook signature
  -> eligible direct-mention detection
  -> permission check
  -> ensure orchestrator session exists (`ao start` / `ao status`)
  -> ao send raw GitHub control prompt with placement context
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

Config boundary:

- Local operator mode loads only the canonical project file at
  `~/.zapbot/projects/<project-key>/project.json`.
- Hosted/platform mode reads `ZAPBOT_*` plus GitHub auth env from the process
  environment, typically materialized from GitHub repository or environment
  secrets.
- Hosted env names are the env-shaped version of the same contract, for
  example `bridge.publicUrl` <-> `ZAPBOT_BRIDGE_URL`,
  `routes[].webhookSecret` <-> `ZAPBOT_WEBHOOK_SECRET`,
  `github.token` <-> `ZAPBOT_GITHUB_TOKEN`, and the GitHub App JSON triple
  <-> `GITHUB_APP_*`.
- Local operator config can route multiple repos under one project key.
  Hosted env mode is one repo route per process.
- Checkout-local `.env` and `agent-orchestrator.yaml` are rejected as legacy
  config artifacts.

## Key modules

| Path | Purpose |
|---|---|
| `src/gateway.ts` | gateway registration + webhook verification/classification |
| `src/mention-detection.ts` | detect eligible direct `@zapbot` mentions outside quoted/code content |
| `src/github-control-request.ts` | canonical raw GitHub control envelope with placement context |
| `src/bridge.ts` | HTTP request handling and orchestrator forwarding |
| `src/orchestrator/github-control-prompt.ts` | render raw GitHub control input into the orchestrator prompt |
| `src/orchestrator/runtime.ts` | ensure the persistent orchestrator exists and forward prompts via `ao send` |
| `src/lifecycle/` | managed-session registry, ownership controller, GC planning, lifecycle command model |
| `bin/resolve-managed-startup-retry.ts` | startup helper that decides whether duplicate-session retry is allowed |
| `bin/ao-spawn-with-moltzap.ts` | worker spawn helper that preserves MoltZap control linkage |
| `bin/moltzap-claude-channel.ts` | worker entrypoint that boots the Claude-side MoltZap channel loop |
| `src/claude-channel/` | local Claude channel server primitives used by the worker runtime |
| `worker/ao-plugin-agent-claude-moltzap/` | checked-in Claude/MoltZap AO agent plugin |
| `src/moltzap/runtime.ts` | decode zapbot MoltZap config and provision `MOLTZAP_*` child env |
| `src/moltzap/identity-allowlist.ts` | enforce optional sender allowlists on inbound MoltZap events |
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

## GitHub token boundary

- The bridge may inject `GH_TOKEN` into AO child sessions so workers can act on
  behalf of the repo.
- The bridge does not itself serialize `GH_TOKEN` into MoltZap env, webhook
  responses, or bridge-authored GitHub artifacts.
- Once `GH_TOKEN` is available inside an AO child session, downstream tools and
  prompts in that session are outside the bridge's enforcement boundary.
- Use least-privilege GitHub auth for that handoff: narrow PAT scopes or the
  smallest-installation GitHub App that still satisfies the worker path.

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

- Each project keeps its managed-session registry under
  `~/.zapbot/projects/<project-key>/state/.zapbot-managed-sessions.json`.
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

- `SIGHUP` re-reads the canonical `~/.zapbot` project config in local operator
  mode, rebuilds `BridgeConfig`, and re-registers bridge routes with the
  gateway.
- Hosted deployment env is fixed for the lifetime of the process. After a
  GitHub secrets or deployment-env change, restart or redeploy instead of
  relying on `SIGHUP`.
- `SIGINT` / `SIGTERM` stop the HTTP server and deregister bridge routes.
- `start.sh` duplicate-session retry is lifecycle-gated: it may stop only a
  matching managed orchestrator record, never a session chosen by tmux-name
  heuristic.
- The current operator floor is: use the registry to decide what is safe to
  inspect or clean up, and leave anything outside that registry alone.
- GitHub comment intake is still permission-gated at the bridge layer before a
  control event reaches the orchestrator.
