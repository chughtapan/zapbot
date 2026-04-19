# Zapbot v2

A thin GitHub webhook bridge that dispatches [agent-orchestrator](https://github.com/anthropics/agent-orchestrator)
agents in response to `@zapbot` mentions on issues. v2 is an HTTP shim — no
state machine, no SQLite, no plan-review flow. Durable state lives in GitHub.

> **`ao` (agent-orchestrator):** Zapbot shells out to the `ao` CLI (from [agent-orchestrator](https://github.com/anthropics/agent-orchestrator)), which receives the issue context and spins up an AI agent to handle the dispatch. The bridge is a thin HTTP webhook listener; `ao` owns the agent lifecycle.

## How It Works

1. GitHub delivers a webhook to the bridge (directly or via a gateway).
2. The bridge verifies the HMAC, extracts the `@zapbot <command>` mention from
   the comment body, and checks the commenter has write access.
3. The bridge shells out to `ao spawn <issue>` with the GitHub App's
   installation token (or PAT if configured); `ao` picks up from there and
   fetches the issue context to dispatch an agent.

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

**Webhook URL:** The bridge listens on `0.0.0.0:3000` by default (configurable via `PORT` env var). Use the gateway URL if you set one up; otherwise, point directly to your bridge's public HTTPS endpoint.

**Private key:** Download the private key (.pem file) from GitHub App settings. You'll reference it as `GITHUB_APP_PRIVATE_KEY` in your `.env` (see step 3).

**Installation ID:** After creating the app, install it on your target repos and note the installation ID from the installation URL (`https://github.com/settings/installations/<id>`).

### 3. Bridge

Clone the zapbot repo and create the required directories:

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/chughtapan/zapbot.git ~/.claude/skills/zapbot
cd ~/.claude/skills/zapbot
```

Create `.env` **before running setup** (the setup script expects it):

```bash
# Two distinct secrets — webhook HMAC vs. bridge Bearer.
# Generate with: openssl rand -hex 32
ZAPBOT_WEBHOOK_SECRET=<same value as GitHub App webhook secret>
ZAPBOT_API_KEY=<random 32-byte hex, used internally by the bridge to authenticate requests>

# GitHub App (preferred authentication method)
GITHUB_APP_ID=<app-id-from-github-app-settings>
GITHUB_APP_PRIVATE_KEY=/path/to/app.pem
GITHUB_APP_INSTALLATION_ID=<installation-id-from-github-app-install>
ZAPBOT_BOT_USERNAME=<app-slug>[bot]

# Alternative: Personal Access Token (less preferred; requires repo-level secrets management)
# ZAPBOT_GITHUB_TOKEN=<ghp_... token with repo & issue:write scopes>

# Gateway (only if using one):
# ZAPBOT_GATEWAY_URL=https://your-app.onrender.com
# ZAPBOT_GATEWAY_SECRET=<matches gateway config>
# ZAPBOT_BRIDGE_URL=<public URL of this bridge>
```

**Important:** Add `.env` to `.gitignore` immediately to prevent secrets from being committed.

```bash
echo ".env" >> .gitignore
git add .gitignore && git commit -m "chore: ignore .env"
```

Now run setup:

```bash
./setup --server
```

This initializes the project and prepares the bridge. Then:

```bash
bin/zapbot-team-init <owner/repo>
./start.sh
```

**`bin/zapbot-team-init`:** Initializes zapbot for a specific repo (owner/repo format, e.g., `anthropics/agent-orchestrator`). This script configures the bridge to listen for webhooks from that repo and sets up any required local state.

**`./start.sh`:** Starts the bridge as a foreground process. For production, consider using a process manager (e.g., `systemd`, `supervisor`) to daemonize and restart on failure.

## For Teammates

Install zapbot as a Claude Code skill:

```bash
git clone https://github.com/chughtapan/zapbot.git ~/.claude/skills/zapbot
cd ~/.claude/skills/zapbot
bun install
```

In Claude Code:

- `/zapbot-publish` — turn your plan into a `zapbot-plan`-labelled GitHub issue.
- On any issue, mention `@zapbot plan this` or `@zapbot investigate this` to
  dispatch an agent.

> **Note:** You do not need to run `./setup --server` or `./start.sh` as a teammate. The bridge is typically run centrally by your team lead. You only need the skill installed for the `/zapbot-publish` command and the `@zapbot` mention handlers in Claude Code to recognize your issues.

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

## Secret Management

### `.env` Safety

- **Never commit `.env`:** Always add `.env` to `.gitignore`.
- **Keep secrets out of the repo:** The `.env` file is local-only and should not be shared via Git. Use a secrets manager (e.g., 1Password, Vault) for team distribution.
- **Private key storage:** Store `GITHUB_APP_PRIVATE_KEY` as a file path on disk (not inline in `.env`). Restrict file permissions: `chmod 600 app.pem`.

### Secret Rotation

If a secret is compromised:

1. **Webhook secret (`ZAPBOT_WEBHOOK_SECRET`):**
   - Generate a new value with `openssl rand -hex 32`.
   - Update it in `.env`.
   - Update it on the GitHub App settings page.

2. **API key (`ZAPBOT_API_KEY`):**
   - Generate a new value with `openssl rand -hex 32`.
   - Update it in `.env`.
   - Restart the bridge (`./start.sh`).

3. **GitHub App private key:**
   - Regenerate a new private key from the GitHub App settings page.
   - Download and save it to disk.
   - Update `GITHUB_APP_PRIVATE_KEY` in `.env` to point to the new file.
   - Restart the bridge.

4. **Personal Access Token (if used):**
   - Revoke it immediately from your GitHub settings.
   - Generate a new token with the minimum required scopes.
   - Update `ZAPBOT_GITHUB_TOKEN` in `.env`.
   - Restart the bridge.

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
