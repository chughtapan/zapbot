# Zapbot

Plan-to-code workflow for teams. Developers create plans, publish them as GitHub
issues for review, and approved plans are automatically implemented by AI agents.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for diagrams and design decisions.

- **webhook-bridge** (bin/webhook-bridge.ts) — Bun HTTP server on port 3000. Front door for webhooks.
- **agent-orchestrator** — port 3001. Manages worktrees, Claude Code agents, CI auto-fix.
- **bin/zapbot-publish.sh** — Creates/updates GitHub issues with plans.
- **bin/share-link.ts** — Generates plannotator share URLs.

## Commands

```bash
./install.sh              # One-time setup (installs tools, creates .env and repo)
./start.sh                # Start everything (bridge + AO + ngrok)
./test/e2e-smoke.sh       # Run E2E tests (14 tests)
bash bin/zapbot-publish.sh <plan-file> --key <name>   # Publish a plan
```

## Testing

Run `./test/e2e-smoke.sh`. Tests create real GitHub issues and clean up after.
Bridge must be running for Test 6 (bridge endpoint tests).

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action.

Key routing rules:
- "publish plan", "share plan", "sync plan", "create issue from plan" → invoke zapbot-publish
