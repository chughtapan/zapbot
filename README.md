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
Webhook bridge on `http://localhost:3000`, dashboard at `http://localhost:3001`.

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
