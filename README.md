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
| Webhook secret | `openssl rand -hex 32` |
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
ZAPBOT_API_KEY=<webhook-secret>

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
        secretEnvVar: ZAPBOT_API_KEY
  frontend:
    repo: chughtapan/frontend-app
    path: /home/user/frontend
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        secretEnvVar: ZAPBOT_API_KEY_FRONTEND
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

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the v2 module layout.
