# Zapbot

Plan-to-code workflow for teams. Developers create plans, publish them as GitHub
issues for review, and approved plans are automatically implemented by AI agents.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action.

Key routing rules:
- "zapbot", "get started with zapbot", "configure zapbot", "zap" → invoke zap (meta-skill: onboarding + routing)
- "publish plan", "share plan", "sync plan", "create issue from plan" → invoke zapbot-publish
- "check status", "workflow status", "what happened to issue" → invoke zapbot-status

## @mention commands (in GitHub issues/PRs)

Users with write access can trigger zapbot by @mentioning it in any issue or PR comment:

| Command | Description |
|---------|-------------|
| `@zapbot plan this` | Start a new workflow (triage, plan, implement, verify) |
| `@zapbot investigate this` | Spawn an investigator agent to debug |
| `@zapbot implement this` | Spawn an implementer agent |
| `@zapbot verify this` | Spawn a QE agent to test and verify |
| `@zapbot status` | Show current workflow state and active agents |
| `@zapbot retry` | Re-spawn the last failed agent |
| `@zapbot abandon` | Stop the workflow |
| `@zapbot help` | Show available commands |
| `@zapbot <message>` | Send a message to the running agent |

The bot responds with an eyes emoji immediately and auto-assigns itself to the issue.

## Commands (teammates)

```
/zapbot-publish    # publish a plan to GitHub with review link
/zapbot-status     # check workflow status for an issue
```

## Commands (eng lead / server)

```bash
bun test              # run unit + store + state-machine tests
bun run bridge        # start webhook bridge (port 3000)
./start.sh            # one-click: gateway/ngrok + webhook + bridge
./test/e2e-smoke.sh   # end-to-end smoke test
./setup --server      # install server dependencies
```

## State machine

Zapbot uses an SDS-inspired two-level state machine. Parent issues are triaged into
sub-issues, each following: PLANNING → REVIEW → APPROVED → IMPLEMENTING →
DRAFT_REVIEW → VERIFYING → DONE. See ARCHITECTURE.md for details.

## Key directories

- `src/store/` — Kysely + SQLite data layer
- `src/state-machine/` — Pure-function state machine engine
- `src/agents/` — Agent spawning, heartbeat, role-specific logic
- `src/config/` — Config loader for agent-orchestrator.yaml, repo map, per-repo webhook secrets
- `src/gateway/` — Gateway client (register/deregister/heartbeat with Railway gateway)
- `src/webhook/` — Webhook event mapping + @mention parsing (extracted for testability)
- `src/github/` — GitHub API client (Octokit + GitHub App auth)
- `src/logger.ts` — Structured logging
- `bin/` — CLI entry points (webhook-bridge, team-init, publish)
- `gateway/` — Railway-deployed webhook proxy (routes GitHub webhooks to registered bridges)
- `skills/` — Claude Code skill definitions (zapbot-publish, zapbot-status)
- `templates/` — Config templates for agent-orchestrator and agent rules
