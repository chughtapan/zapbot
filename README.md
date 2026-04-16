# Zapbot

Plan-to-code workflow for teams. Developers create plans, publish them as GitHub
issues for review, and approved plans are automatically implemented by AI agents
through a multi-stage state machine.

## How It Works

Zapbot uses an SDS-inspired two-level state machine:

1. **Parent Issue (Epic):** A high-level intent is triaged into independent sub-issues
2. **Sub-Issues (Tasks):** Each follows its own lifecycle:
   `PLANNING -> REVIEW -> APPROVED -> IMPLEMENTING -> DRAFT_REVIEW -> VERIFYING -> DONE`

### Agent Pipeline

| Agent | Role |
|-------|------|
| **Triage** | Decomposes parent issue into scoped sub-issues |
| **Planner** | Drafts implementation plan, publishes for review |
| **Implementer** | Writes code from approved plan, creates draft PR |
| **QE** | Runs tests, verifies quality, ships the PR |

### Interacting with Zapbot

**Via @mention (recommended):** Type `@zapbot <command>` in any issue or PR comment:

```
@zapbot plan this          # start a new workflow
@zapbot investigate this   # spawn an investigator to debug
@zapbot implement this     # spawn an implementer agent
@zapbot verify this        # spawn a QE agent
@zapbot status             # check workflow state
@zapbot retry              # re-spawn a failed agent
@zapbot abandon            # stop the workflow
@zapbot help               # list all commands
@zapbot <any message>      # forward to the running agent
```

The bot responds with an eyes emoji immediately and auto-assigns itself to the issue.

**Via assignment:** Assign an issue to `zapbot[bot]` to start a workflow. Labels determine which agent to spawn.

---

## Quick Start (Eng Lead)

Three steps: deploy the gateway, create a GitHub App, start the bridge.

### 1. Deploy the Gateway

The gateway gives you a stable HTTPS URL that routes GitHub webhooks to your
bridge. Deploy it once, use the URL forever.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/chughtapan/zapbot) Free tier

After deploy, verify: `curl https://your-app.onrender.com/healthz`

Your webhook endpoint is `https://your-app.onrender.com/api/webhooks/github`.

### 2. Create a GitHub App

Create a new app at https://github.com/settings/apps/new:

| Field | Value |
|-------|-------|
| App name | Pick any name (shows as `your-name[bot]` on issues) |
| Homepage URL | `https://github.com/chughtapan/zapbot` |
| Webhook URL | `https://your-app.onrender.com/api/webhooks/github` |
| Webhook secret | Run `openssl rand -hex 32` and save the output |

**Permissions** (Repository):

| Permission | Access |
|------------|--------|
| Issues | Read & write |
| Pull requests | Read & write |
| Contents | Read & write |
| Checks | Read-only |
| Commit statuses | Read-only |

**Events:** Issues, Issue comment, Pull request, Pull request review, Check run, Check suite

After creating:

1. Note the **App ID** from the app's General page
2. Generate a **private key** (`.pem` file), save to `~/.zapbot/`
3. Click **Install App**, select your repos
4. Note the **Installation ID** from `https://github.com/settings/installations/<ID>`

### 3. Configure and Start the Bridge

```bash
git clone https://github.com/chughtapan/zapbot.git ~/.claude/skills/zapbot
cd ~/.claude/skills/zapbot && ./setup --server
```

Create `~/.zapbot/.env`:

```bash
ZAPBOT_API_KEY=<webhook-secret-from-step-2>
ZAPBOT_CONFIG=~/.zapbot/agent-orchestrator.yaml

GITHUB_APP_ID=<app-id>
GITHUB_APP_PRIVATE_KEY=~/.zapbot/<your-app>.pem
GITHUB_APP_INSTALLATION_ID=<installation-id>
ZAPBOT_BOT_USERNAME=<your-app-name>[bot]

ZAPBOT_GATEWAY_URL=https://your-app.onrender.com
ZAPBOT_GATEWAY_SECRET=<gateway-secret-from-render-dashboard>
ZAPBOT_BRIDGE_URL=http://<your-server-ip>:3000
```

Onboard your repo and start:

```bash
bin/zapbot-team-init <owner/repo>
./start.sh --gateway
```

You should see:

```
Using GitHub App for API calls  appId=<id> installationId=<id>
Registered 1 repo(s) with gateway at https://your-app.onrender.com
```

### Alternative: Personal Access Token

If you don't want to create a GitHub App, you can use a personal access token
from a dedicated GitHub account instead. Create the account, generate a
[fine-grained PAT](https://github.com/settings/personal-access-tokens/new)
with Issues, Pull requests, and Contents permissions, then set:

```bash
ZAPBOT_GITHUB_TOKEN=<pat>
ZAPBOT_BOT_USERNAME=<account-username>
```

The bot will appear as a regular user, not `[bot]`. You'll need to assign
issues to this account to trigger workflows.

---

## For Teammates

### Install (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/chughtapan/zapbot/main/install.sh | bash
```

Downloads 3 skill files into `~/.claude/skills/`. No git, no clone, no setup needed.
Updates are checked automatically every hour. When available, Claude offers to upgrade.

### Configure

Your eng lead will share a bridge URL and secret. When you first run `/zapbot-publish`,
Claude will ask for these and save them to `~/.zapbot/config.json`.

### Use

In Claude Code:
- `/zapbot-publish` -- publish a plan as a GitHub issue with review link
- `/zapbot-status` -- check workflow status for an issue

---

## Multi-Repo Support

Define multiple projects in `~/.zapbot/agent-orchestrator.yaml`:

```yaml
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    scm:
      plugin: github
      webhook:
        secretEnvVar: ZAPBOT_API_KEY
  frontend:
    repo: chughtapan/frontend-app
    path: /home/user/frontend
    scm:
      plugin: github
      webhook:
        secretEnvVar: ZAPBOT_API_KEY_FRONTEND
```

The bridge routes webhooks by `repository.full_name`, verifies HMAC signatures
with per-repo secrets, and passes `--project` context to `ao spawn`.

---

## Development

```bash
bun test              # run unit tests
bun run bridge        # start webhook bridge directly
./test/e2e-smoke.sh   # end-to-end smoke test
```

## Other Deploy Options

The gateway is a plain Bun HTTP server. Besides Render, you can deploy it anywhere:

**Railway** ($5 trial credit):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/chughtapan/zapbot&rootDir=gateway&envs=GATEWAY_SECRET&GATEWAY_SECRETDesc=Shared+secret+for+bridge+auth)

**Docker** (any cloud or self-hosted):

```bash
cd gateway && docker build -t zapbot-gateway .
docker run -p 8080:8080 -e GATEWAY_SECRET=<your-secret> zapbot-gateway
```

**Bare Bun** (run directly on your server):

```bash
cd gateway && bun install && GATEWAY_SECRET=<secret> bun run src/index.ts
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine design,
data model, and transition tables.
