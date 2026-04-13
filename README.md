# Zapbot

Plan-to-code workflow for teams. Create plans in Claude Code, publish them as GitHub issues for team review, and approved plans are automatically implemented by AI agents.

## Quickstart

```bash
./install.sh    # One-time: installs dependencies, creates test repo
./start.sh      # Every time: starts bridge + AO + ngrok tunnel
```

Then in Claude Code:
```
/plan                    # Create a plan
/zapbot-publish          # Publish to GitHub issue
```

Add the `plan-approved` label on the issue. An agent spawns and creates a PR.

## How It Works

```
Developer (Claude Code)          GitHub               Zapbot Server
  │                                │                      │
  │ /zapbot-publish ──────────────▶│ Issue created         │
  │   + plan body                  │ + plannotator link    │
  │   + share link                 │ + zapbot-plan label   │
  │                                │                      │
  │                                │ Team reviews          │
  │                                │ via plannotator       │
  │                                │                      │
  │                                │ plan-approved ────────▶│ webhook-bridge
  │                                │ label added           │ ├── ao spawn
  │                                │                      │ │   (worktree)
  │                                │                      │ │   (Claude Code)
  │                                │◀── PR created ────────│ └── creates PR
  │                                │                      │
  │ pull, review, merge            │                      │
```

## Components

- **webhook-bridge** (port 3000) — receives GitHub webhooks, triggers `ao spawn` on `plan-approved`, proxies to AO
- **agent-orchestrator** (port 3001) — manages worktrees, Claude Code agents, CI auto-fix, dashboard
- **bin/zapbot-publish.sh** — creates/updates GitHub issues with plan content and plannotator links
- **bin/share-link.ts** — generates plannotator share URLs with optional callback params

## Configuration

All settings via environment variables (set in `.env`):

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_WEBHOOK_SECRET` | (required) | HMAC secret for webhook verification |
| `ZAPBOT_REPO` | auto-detected | GitHub repo (owner/name) |
| `ZAPBOT_BRIDGE_PORT` | 3000 | Webhook bridge port |
| `ZAPBOT_AO_PORT` | 3001 | Agent-orchestrator port |
| `ZAPBOT_APPROVE_LABEL` | plan-approved | Label that triggers implementation |
| `ZAPBOT_BRIDGE_URL` | (from ngrok) | Public URL for plannotator callbacks |

## Troubleshooting

**Bridge not starting:**
```bash
cat /tmp/zapbot-bridge.log
lsof -i :3000    # Check port conflict
```

**AO not starting:**
```bash
cat /tmp/zapbot-ao.log
lsof -i :3001    # Check port conflict
```

**Webhook not firing:**
```bash
# Check webhook delivery in GitHub
gh api repos/<owner>/<repo>/hooks --jq '.[].last_response'

# Test bridge locally
curl -X POST http://localhost:3000/healthz
```

**Agent not spawning after label:**
```bash
ao status        # Check sessions
ao session ls    # List all sessions
cat /tmp/zapbot-bridge.log | grep "spawn"
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, data flow, design decisions
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, project structure, dev workflow
- [CHANGELOG.md](CHANGELOG.md) — release history
- [CLAUDE.md](CLAUDE.md) — project instructions for Claude Code

## Prerequisites

node 20+, git 2.25+, bun, gh CLI (authenticated), tmux, claude (Claude Code), ngrok (with auth token)
