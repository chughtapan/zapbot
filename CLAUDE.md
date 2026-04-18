# Zapbot

Thin GitHub webhook bridge for dispatching agent-orchestrator agents. v2
migrated durable state out of zapbot and into GitHub itself (issue labels,
assignees, comments). Zapbot verifies the webhook, classifies the mention,
and shells out to `ao spawn <issue>`.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the
Skill tool as your FIRST action.

Key routing rules:
- "zapbot", "zap" → invoke zap (router + help)
- "publish plan", "share plan", "create issue from plan" → invoke zapbot-publish

## @mention commands (in GitHub issues)

Users with write access can trigger zapbot on any `zapbot-plan` issue:

| Command | Description |
|---------|-------------|
| `@zapbot plan this` | Dispatch an agent on this issue |
| `@zapbot investigate this` | Dispatch an investigator |
| `@zapbot status` | Post a summary of the issue's current state |

Anything else is acknowledged with a "didn't recognize" comment.

## Commands (teammates)

```
/zapbot publish    # publish a plan to GitHub as a zapbot-plan issue
/zapbot help       # show commands
```

## Commands (eng lead / server)

```bash
bun x vitest run      # unit tests
bun run bridge        # start webhook bridge (port 3000)
./start.sh            # boot: ao + webhook bridge, register with gateway if configured
./test/e2e-smoke.sh   # end-to-end smoke test
./setup --server      # install server dependencies (ao + systemd)
```

## Key directories

- `v2/` — v2 bridge modules (types, gateway, bridge, ao/dispatcher, github-state, mention-parser)
- `src/config/` — Config loader for agent-orchestrator.yaml
- `src/github/` — GitHub client (Octokit + GitHub App auth)
- `src/http/` — HMAC signature verification
- `src/logger.ts` — Structured logging
- `bin/` — CLI entry points (webhook-bridge, zapbot-team-init, zapbot-publish.sh)
- `gateway/` — Deployed webhook proxy (forwards GitHub webhooks to registered bridges)
- `skills/` — Claude Code skill definitions (zap, zapbot-publish)
- `templates/` — Config template for agent-orchestrator.yaml

See ARCHITECTURE.md for the v2 module layout and data flow.
