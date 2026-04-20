# Zapbot

Zapbot is a thin GitHub webhook bridge for `ao`.

It verifies GitHub webhooks, checks repo permissions, and dispatches direct
`ao spawn <issue>` sessions from `@zapbot` issue comments. Durable task state
lives in GitHub, not inside zapbot.

## Current runtime

1. GitHub sends `issue_comment` webhooks to `/api/webhooks/github`.
2. zapbot verifies the HMAC and parses the `@zapbot ...` command.
3. zapbot checks that the commenter has write access.
4. zapbot shells out to `ao spawn <issue>` with:
   - `AO_CONFIG_PATH`
   - `AO_PROJECT_ID`
   - `GH_TOKEN`
   - optional `MOLTZAP_*` env for session-to-session communication

Supported commands:

| Comment | Effect |
|---|---|
| `@zapbot plan this` | spawn an `ao` session on the issue |
| `@zapbot investigate this` | spawn an `ao` session on the issue |
| `@zapbot status` | post a GitHub-native issue summary |

## MoltZap

zapbot can provision MoltZap credentials for spawned `ao` sessions.

Configure one of these modes:

| Env | Meaning |
|---|---|
| `ZAPBOT_MOLTZAP_SERVER_URL` + `ZAPBOT_MOLTZAP_API_KEY` | pass through a pre-provisioned MoltZap agent key to every spawned session |
| `ZAPBOT_MOLTZAP_SERVER_URL` + `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` | register a fresh MoltZap agent for each spawned session and pass its key to that session |
| `ZAPBOT_MOLTZAP_ALLOWED_SENDERS` | optional comma-separated sender allowlist forwarded to the session runtime |

If no `ZAPBOT_MOLTZAP_*` env is set, zapbot still works as a plain GitHub-to-`ao`
bridge.

## Setup

### Bridge host

Create a `.env` with the required bridge settings:

```bash
ZAPBOT_WEBHOOK_SECRET=<github webhook secret>
ZAPBOT_API_KEY=<local broker bearer>

GITHUB_APP_ID=<app id>
GITHUB_APP_PRIVATE_KEY=/path/to/app.pem
GITHUB_APP_INSTALLATION_ID=<installation id>
ZAPBOT_BOT_USERNAME=<app-slug>[bot]

ZAPBOT_CONFIG=/path/to/agent-orchestrator.yaml
ZAPBOT_BRIDGE_URL=https://bridge.example.com

# Optional gateway
# ZAPBOT_GATEWAY_URL=https://gateway.example.com
# ZAPBOT_GATEWAY_SECRET=<gateway secret>

# Optional MoltZap
# ZAPBOT_MOLTZAP_SERVER_URL=wss://moltzap.example/ws
# ZAPBOT_MOLTZAP_API_KEY=<static key>
# ZAPBOT_MOLTZAP_REGISTRATION_SECRET=<invite code>
# ZAPBOT_MOLTZAP_ALLOWED_SENDERS=agent-a,agent-b
```

Install and start:

```bash
bun install
./setup --server
bin/zapbot-team-init <owner/repo>
./start.sh
```

### GitHub App

Minimum GitHub App setup:

- Webhook URL: `https://<bridge-or-gateway>/api/webhooks/github`
- Webhook secret: same value as `ZAPBOT_WEBHOOK_SECRET`
- Permissions: Issues read/write, Pull requests read/write, Contents read/write, Checks read
- Event: `Issue comment`

## Development

```bash
bun run test
bun run lint
bun run build
bun run bridge
```

## Repo map

- `src/` — current runtime: webhook intake, config load/reload, GitHub helpers, `ao` dispatch, MoltZap session provisioning
- `gateway/` — optional bridge registry / webhook proxy
- `bin/webhook-bridge.ts` — bridge entrypoint

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current module layout.
