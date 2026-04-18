# Zapbot v2 Architecture

v2 is a thin HTTP bridge. All durable workflow state lives in GitHub (issue
labels, assignees, comments). The bridge does three things:

1. Receive + verify webhooks.
2. Classify webhooks into `ignore` or a `mention_command`.
3. Dispatch `ao spawn <issue>` for commands.

Everything else — plan review, agent state machines, retries, progress polling —
has been moved out of zapbot or dropped. If you need it, read it from GitHub.

## Modules

All v2 code lives under `v2/`. `src/` holds only shared KEEP modules (GitHub
client, HMAC verify, config loader, logger).

| Path | Purpose |
|------|---------|
| `v2/types.ts` | Branded IDs, tagged errors, `Result<T,E>`, `MentionCommand` union |
| `v2/mention-parser.ts` | Parse `@zapbot <command>` from a comment body |
| `v2/gateway.ts` | Gateway registration/heartbeat + HMAC verify + envelope classification |
| `v2/bridge.ts` | HTTP server, webhook handler, dispatch orchestration |
| `v2/ao/dispatcher.ts` | Shell out to `ao spawn <issue>` with env context |
| `v2/github-state.ts` | Read durable state from GitHub via Octokit |
| `bin/webhook-bridge.ts` | CLI shim: load config, boot `startBridge`, install signal handlers |

## Data flow

```
GitHub → (gateway, optional) → bridge.ts /api/webhooks/github
  ├── gateway.verifyAndClassify(envelope, resolveSecret, botUsername)
  │     ├── verifySignature (src/http/verify-signature.ts)
  │     └── mention-parser.parseMention
  ├── bridge.handleClassifiedWebhook
  │     ├── createGitHubClient.addReaction / getUserPermission / postComment
  │     └── dispatch({ repo, issue, projectName, configPath, installationToken })
  │           └── Bun.spawn ["ao", "spawn", issue]
  └── errorResponse on any tagged error (401/403/500/502/503)
```

## Error channels

Every public function in v2 declares its error channel as `Result<T, E>` with
a tagged union `E`. Nothing in v2 throws across a module boundary.

| Module | Error tags |
|--------|-----------|
| `gateway` | `GatewayUnreachable`, `GatewayRejected`, `GatewayAuthMissing`, `SignatureMismatch`, `InvalidJson`, `UnconfiguredRepo`, `SecretMissing` |
| `dispatcher` | `TokenMintFailed`, `AoSpawnFailed`, `ProjectNotConfigured` |
| `github-state` | `GhCliMissing`, `GhCliFailed`, `IssueNotFound`, `ParseFailed` |

HTTP status mapping (in `bridge.ts`):

| Tag | Status |
|-----|--------|
| `SignatureMismatch` | 401 |
| `InvalidJson` | 400 |
| `UnconfiguredRepo` / `SecretMissing` / `ProjectNotConfigured` | 403 |
| `AoSpawnFailed` | 502 |
| `TokenMintFailed` | 503 |

## Reload

`SIGHUP` re-reads `.env` and `agent-orchestrator.yaml` from disk, builds a new
`BridgeConfig`, and calls `runningBridge.reload(next)`. Registration with the
gateway is redone; in-flight requests continue under the old config.

## What got deleted in the v2 migration

- `src/state-machine/*`, `src/store/*`, `src/effects/*` — no SQLite, no engine.
- `src/agents/*` (except the `getInstallationToken` helper) — no progress
  poller, heartbeat, cleanup sweep, or spawner wrapper.
- `src/gateway/client.ts`, `src/webhook/mapper.ts`, `src/workflow-id.ts` —
  functionality moved into `v2/gateway.ts` and `v2/mention-parser.ts`.
- `templates/agent-rules-*`, `bin/zapbot-update-check`, `bin/share-link.ts`,
  plannotator callbacks — dropped entirely.
