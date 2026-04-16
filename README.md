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

---

## For Teammates

### Install (30 seconds)

```bash
git clone https://github.com/chughtapan/zapbot.git ~/.claude/skills/zapbot
cd ~/.claude/skills/zapbot && ./setup
```

This installs the Claude Code skill only. No server infrastructure.

### Configure

Your eng lead will share a bridge config snippet. When you first run `/zapbot-publish`,
Claude will ask for your bridge URL and secret and save them to `~/.zapbot/config.json`.

### Use

In Claude Code:
- `/zapbot-publish` — publish a plan as a GitHub issue with review link
- `/zapbot-status` — check workflow status for an issue

---

## For Eng Leads

### Server Setup

```bash
git clone https://github.com/chughtapan/zapbot.git ~/.claude/skills/zapbot
cd ~/.claude/skills/zapbot && ./setup --server
```

The `--server` flag installs additional dependencies: ngrok, agent-orchestrator,
and validates each installation.

### Onboard a Repo

```bash
bin/zapbot-team-init <owner/repo>
```

This generates `agent-orchestrator.yaml`, `.env`, GitHub labels, and a config
snippet to share with teammates.

### Start the Bridge

```bash
./start.sh [project-dir]
```

Starts ngrok, configures GitHub webhooks, and launches the agent-orchestrator.
Webhook bridge on `http://localhost:3000` (configurable via `ZAPBOT_BRIDGE_PORT` in `.env`),
AO dashboard on `http://localhost:3001` (configurable via `port:` in `agent-orchestrator.yaml`).

### GitHub App Setup

Zapbot needs a GitHub App so it can be assigned to issues and interact with repos
as `zapbot[bot]`. A GitHub App is preferred over a regular account (no seat consumed,
proper `[bot]` suffix, fine-grained permissions).

#### 1. Create the App

Create a new GitHub App at https://github.com/settings/apps/new and fill in:

| Field | Value |
|-------|-------|
| App name | `zapbot` (or any name you like) |
| Homepage URL | Your repo URL or `https://github.com` |
| Webhook URL | Your gateway URL + `/api/webhooks/github` (deploy the gateway first, see below) |
| Webhook secret | A random secret (save this, you'll need it for `ZAPBOT_API_KEY`) |

#### 2. Set Permissions

Under **Repository permissions**:

| Permission | Access |
|------------|--------|
| Issues | Read & write |
| Pull requests | Read & write |
| Contents | Read & write |
| Metadata | Read-only |

Under **Organization permissions**: none needed.

#### 3. Subscribe to Events

Check these boxes under **Subscribe to events**:

- [x] Issues
- [x] Issue comment
- [x] Pull request
- [x] Pull request review

#### 4. Generate a Private Key

After creating the app, scroll to **Private keys** and click **Generate a private key**.
Save the downloaded `.pem` file somewhere safe (e.g. `~/.zapbot/zapbot-app.pem`).

#### 5. Install the App

Go to your app's page → **Install App** → select your account/org → choose
**Only select repositories** → pick the repos zapbot should manage.

After installing, note the **Installation ID** from the URL:
`https://github.com/settings/installations/<INSTALLATION_ID>`

#### 6. Configure Environment

Add these to your `.env`:

```bash
GITHUB_APP_ID=<your-app-id>              # from the app's General page
GITHUB_APP_PRIVATE_KEY=~/.zapbot/zapbot-app.pem  # path to .pem file
GITHUB_APP_INSTALLATION_ID=<installation-id>     # from step 5
```

The bridge auto-detects GitHub App auth when `GITHUB_APP_ID` is set. It takes
priority over `ZAPBOT_GITHUB_TOKEN` (PAT mode).

#### 7. Verify

Restart the bridge and check the logs for:

```
Using GitHub App for API calls  appId=<your-app-id> installationId=<id>
```

The bot will now appear as `zapbot[bot]` (or `your-app-name[bot]`) and can be
assigned to issues to trigger workflows.

### Gateway (replaces ngrok)

The `gateway/` service provides a stable HTTPS URL that routes GitHub webhooks to
your local bridge. Deploy it once, use the URL forever. No ngrok, no dynamic URLs.

#### One-Click Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/chughtapan/zapbot&rootDir=gateway&envs=GATEWAY_SECRET&GATEWAY_SECRETDesc=Shared+secret+for+bridge+auth)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/chughtapan/zapbot)

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/chughtapan/zapbot)

After deploying, your gateway URL will be something like:
- Railway: `https://zapbot-gateway-production.up.railway.app`
- Render: `https://zapbot-gateway.onrender.com`
- Heroku: `https://your-app-name.herokuapp.com`

The webhook endpoint is `<gateway-url>/api/webhooks/github`. Use this when
setting up your GitHub App's webhook URL.

Verify it's running: `curl <gateway-url>/healthz`

#### Manual Deploy

```bash
cd gateway && bun run src/index.ts   # start locally
```

Or with Docker:

```bash
cd gateway && docker build -t zapbot-gateway .
docker run -p 8080:8080 -e GATEWAY_SECRET=<your-secret> zapbot-gateway
```

See `gateway/.env.example` for all configuration options.

#### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GATEWAY_SECRET` | Yes (unless using JWT) | Shared secret for bridge registration auth |
| `PORT` | No (default: 8080) | Port to listen on (set automatically by Railway/Render/Heroku) |
| `SUPABASE_JWT_SECRET` | No | JWT secret for Supabase-based auth (advanced) |

### Multi-Repo Support

Define multiple projects in `agent-orchestrator.yaml`:

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

### Development

```bash
bun test              # run unit tests
bun run bridge        # start webhook bridge directly
./test/e2e-smoke.sh   # end-to-end smoke test
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine design,
data model, and transition tables.
