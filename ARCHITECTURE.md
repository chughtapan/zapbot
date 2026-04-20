# Zapbot Architecture

zapbot is a thin control shim around `ao`.

It does not own durable workflow state, task retries, agent teams, or an
internal state machine. The live path is GitHub webhook intake forwarded to a
persistent per-project AO orchestrator session. The orchestrator owns all
dispatch and worker-spawning decisions.

See [RUNTIME_CONTRACT.md](RUNTIME_CONTRACT.md) for the authoritative statement of
runtime invariants and component responsibilities.

## Runtime shape (orchestrator mode)

```text
GitHub issue_comment webhook
  -> HMAC verify
  -> mention classification
  -> permission check
  -> GitHub installation token mint
  -> ensure project orchestrator session (ao spawn / ao start if absent)
  -> forward control event prompt -> ao send <session> <prompt>
  -> orchestrator decides dispatch, spawns workers via ao-spawn-with-moltzap
  -> workers coordinate with orchestrator over MoltZap DMs
  -> durable artifacts published back to GitHub
```

## Key modules

| Path | Purpose |
|---|---|
| `v2/gateway.ts` | gateway registration + webhook verification/classification |
| `v2/mention-parser.ts` | parse `@zapbot ...` commands from issue comments |
| `v2/bridge.ts` | HTTP request handling and command dispatch |
| `v2/orchestrator/control-event.ts` | shape GitHub control input as a prompt for the persistent orchestrator |
| `v2/orchestrator/runtime.ts` | ensure orchestrator session exists and forward control prompts |
| `v2/moltzap/runtime.ts` | decode zapbot MoltZap config and provision `MOLTZAP_*` child env |
| `v2/moltzap/supervisor.ts` | pure reconnect/backoff policy for MoltZap runtimes |
| `v2/moltzap/identity-allowlist.ts` | pure sender allowlist gate |
| `v2/github-state.ts` | GitHub-native issue state reads |
| `bin/webhook-bridge.ts` | entrypoint: load config, boot bridge, install reload/shutdown hooks |
| `bin/ao-spawn-with-moltzap.ts` | spawn worker sessions with MoltZap credentials provisioned |

## Error model

The live modules use tagged errors and `Result<T, E>` across module boundaries.

Current bridge-visible dispatch failures:

| Tag | Meaning |
|---|---|
| `TokenMintFailed` | GitHub installation token could not be minted |
| `AoSpawnFailed` | the `ao spawn` subprocess failed |
| `MoltzapProvisionFailed` | zapbot could not provision MoltZap env for the child session |
| `ProjectNotConfigured` | the repo is not routed in zapbot config |

## MoltZap boundary

zapbot does not implement a MoltZap server and does not become the agent
runtime. Its responsibility is narrower:

1. Decode `ZAPBOT_MOLTZAP_*` env at boot.
2. Build `MOLTZAP_*` env for the orchestrator session when provisioning workers.
3. Optionally register a fresh MoltZap agent per dispatch when a registration
   secret is available.

The orchestrator session and each spawned worker session are responsible for
registering as MoltZap clients and using those credentials for live
coordination. All live orchestrator↔worker coordination occurs over MoltZap
DMs; GitHub remains the durable record (see RUNTIME_CONTRACT.md §7–§9).

## Reload and shutdown

- `SIGHUP` re-reads `.env` and `agent-orchestrator.yaml`, rebuilds `BridgeConfig`,
  and re-registers bridge routes with the gateway.
- `SIGINT` / `SIGTERM` stop the HTTP server and deregister bridge routes.
