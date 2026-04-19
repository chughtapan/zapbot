# Zapbot Architecture

zapbot is a thin bridge around `ao`.

It does not own durable workflow state, task retries, agent teams, or an
internal state machine. Those older surfaces have been removed from the shipped
runtime. The live path is GitHub webhook intake plus direct `ao spawn`.

## Runtime shape

```text
GitHub issue_comment webhook
  -> HMAC verify
  -> mention classification
  -> permission check
  -> GitHub installation token mint
  -> optional MoltZap session provisioning
  -> Bun.spawn(["ao", "spawn", issue], env)
```

## Key modules

| Path | Purpose |
|---|---|
| `v2/gateway.ts` | gateway registration + webhook verification/classification |
| `v2/mention-parser.ts` | parse `@zapbot ...` commands from issue comments |
| `v2/bridge.ts` | HTTP request handling and command dispatch |
| `v2/ao/dispatcher.ts` | direct `ao spawn <issue>` execution |
| `v2/moltzap/runtime.ts` | decode zapbot MoltZap config and provision `MOLTZAP_*` child env |
| `v2/moltzap/supervisor.ts` | pure reconnect/backoff policy for MoltZap runtimes |
| `v2/moltzap/identity-allowlist.ts` | pure sender allowlist gate |
| `v2/github-state.ts` | GitHub-native issue state reads |
| `bin/webhook-bridge.ts` | entrypoint: load config, boot bridge, install reload/shutdown hooks |

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
2. If configured, build `MOLTZAP_*` env for a spawned `ao` session.
3. Optionally register a fresh MoltZap agent per dispatch when a registration
   secret is available.

The spawned session is responsible for actually using those credentials.

## Reload and shutdown

- `SIGHUP` re-reads `.env` and `agent-orchestrator.yaml`, rebuilds `BridgeConfig`,
  and re-registers bridge routes with the gateway.
- `SIGINT` / `SIGTERM` stop the HTTP server and deregister bridge routes.
