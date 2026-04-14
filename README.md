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

## Install

```bash
git clone https://github.com/chughtapan/zapbot.git
cd zapbot
./setup
```

## Onboard a Repo (one-time, by eng lead)

Run `bin/zapbot-team-init` once per repo to generate `agent-orchestrator.yaml`,
`.env`, labels, and CLAUDE.md routing. This is a one-time setup done by the
engineering lead, not by each developer.

## Start

```bash
./start.sh
```

This starts ngrok, configures GitHub webhooks, and launches the
agent-orchestrator. Webhook bridge on `http://localhost:3000`,
dashboard at `http://localhost:3001`.

## Development

```bash
bun test              # run unit tests
bun run bridge        # start webhook bridge directly
./test/e2e-smoke.sh   # end-to-end smoke test
```

## Multi-Repo Support

Zapbot can manage multiple repos from a single bridge instance. Define projects
in `agent-orchestrator.yaml`:

```yaml
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    scm:
      plugin: github
      webhook:
        secretEnvVar: GITHUB_WEBHOOK_SECRET
  frontend:
    repo: chughtapan/frontend-app
    path: /home/user/frontend
    scm:
      plugin: github
      webhook:
        secretEnvVar: GITHUB_WEBHOOK_SECRET_FRONTEND
```

The bridge routes webhooks by `repository.full_name`, verifies HMAC signatures
with per-repo secrets, and passes `--project` context to `ao spawn`. Webhooks
from unconfigured repos are rejected with 403.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine design,
data model, and transition tables.
