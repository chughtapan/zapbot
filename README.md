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
./install.sh
```

## Onboard a Repo

After install, run `bin/zapbot-team-init` to configure a GitHub repo with the
required labels and webhook.

## Start

```bash
./start.sh
```

This starts ngrok, configures the GitHub webhook, and launches the
agent-orchestrator. Dashboard at `http://localhost:3000`.

## Development

```bash
bun test              # run unit tests
bun run bridge        # start webhook bridge directly
./test/e2e-smoke.sh   # end-to-end smoke test
```

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full state machine design,
data model, and transition tables.
