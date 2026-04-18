# Zapbot v2

A thin GitHub webhook bridge that dispatches [agent-orchestrator](https://github.com/anthropics/agent-orchestrator)
agents in response to `@zapbot` mentions on issues. v2 is an HTTP shim — no
state machine, no SQLite, no plan-review flow. Durable state lives in GitHub.

## How It Works

1. GitHub delivers a webhook to the bridge (directly or via a gateway).
2. The bridge verifies the HMAC, extracts the `@zapbot <command>` mention from
   the comment body, and checks the commenter has write access.
3. The bridge shells out to `ao spawn <issue>` with the project's
   installation token; `ao` picks up from there.

Supported commands:

| Mention | Action |
|---------|--------|
| `@zapbot plan this` | Dispatch an agent on the issue |
| `@zapbot investigate this` | Dispatch an investigator |
| `@zapbot status` | Post a summary of the issue's current state |

Any other `@zapbot …` text is acknowledged with a "didn't recognize" comment.

## Quick Start (Eng Lead)

Three steps: deploy the gateway (optional), create a GitHub App, start the bridge.

### 1. Gateway (optional)

The [gateway](./gateway) gives you a stable HTTPS URL that forwards GitHub
webhooks to a bridge on any network. If your bridge is already reachable from
GitHub, skip this step and point the GitHub App webhook directly at it.

### 2. GitHub App

Create an app at https://github.com/settings/apps/new with:

| Field | Value |
|-------|-------|
| Webhook URL | `https://<gateway-or-bridge-host>/api/webhooks/github` |
| Webhook secret | `openssl rand -hex 32` (store as `ZAPBOT_WEBHOOK_SECRET`) |
| Permissions | Issues R/W, Pull requests R/W, Contents R/W, Checks R |
| Events | Issue comment |

Note the App ID, generate a private key, install the app on your repos, note
the installation ID.

### 3. Bridge

```bash
git clone https://github.com/chughtapan/zapbot.git ~/.claude/skills/zapbot
cd ~/.claude/skills/zapbot && ./setup --server
```

Create `.env` in your project:

```bash
# Two distinct secrets — webhook HMAC vs. broker Bearer.
ZAPBOT_WEBHOOK_SECRET=<openssl rand -hex 32, also configured on the GitHub App>
ZAPBOT_API_KEY=<openssl rand -hex 32, bearer for the local broker>

# GitHub App (preferred)
GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=/path/to/app.pem
GITHUB_APP_INSTALLATION_ID=<installation-id>
ZAPBOT_BOT_USERNAME=<app-slug>[bot]

# Or a personal access token instead of the App:
# ZAPBOT_GITHUB_TOKEN=<pat>

# Gateway (only if using one):
# ZAPBOT_GATEWAY_URL=https://your-app.onrender.com
# ZAPBOT_GATEWAY_SECRET=<matches gateway config>
# ZAPBOT_BRIDGE_URL=<public URL of this bridge>
```

Then:

```bash
bin/zapbot-team-init <owner/repo>
./start.sh
```

## For Teammates

```bash
curl -fsSL https://raw.githubusercontent.com/chughtapan/zapbot/main/install.sh | bash
```

In Claude Code:

- `/zapbot-publish` — turn your plan into a `zapbot-plan`-labelled GitHub issue.
- On any issue, mention `@zapbot plan this` or `@zapbot investigate this` to
  dispatch an agent.

## Multi-Repo

Define multiple projects in `agent-orchestrator.yaml`:

```yaml
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        secretEnvVar: ZAPBOT_WEBHOOK_SECRET
  frontend:
    repo: chughtapan/frontend-app
    path: /home/user/frontend
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        secretEnvVar: ZAPBOT_WEBHOOK_SECRET_FRONTEND
```

The bridge routes by `repository.full_name` and verifies HMAC with the
per-repo secret resolved from `secretEnvVar`.

## Development

```bash
bun install
bun x vitest run       # unit tests
bun run bridge         # start webhook bridge directly
./test/e2e-smoke.sh    # end-to-end smoke test
```

## Testing

Unit and property tests run under [vitest](https://vitest.dev).
[fast-check](https://fast-check.dev) drives property-based coverage of the
HMAC webhook verifier (`test/verify-signature.property.test.ts`, ~200 runs per
property): valid signatures accepted, and mutations of the signature, body, or
secret rejected.

testcontainers and Playwright are deferred — v2 has no database layer and no
browser-facing surface, so they have no target yet. Reintroduce when a DB or
UI subsystem lands.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the v2 module layout.
