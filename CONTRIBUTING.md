# Contributing

## Setup

```bash
# Install zapbot globally
git clone https://github.com/chughtapan/zapbot ~/.claude/skills/zapbot
cd ~/.claude/skills/zapbot

# Teammate setup (installs bun, skills only — no infra)
./setup

# Eng lead / server setup (also installs ngrok, ao)
./setup --server

# Onboard a project
cd ~/your-project
~/.claude/skills/zapbot/bin/zapbot-team-init
```

Prerequisites depend on your role:

- **Teammate** (publishes plans, checks status): git 2.25+, gh CLI (authenticated). Bun is auto-installed by `./setup`.
- **Server / eng lead** (runs the bridge): git 2.25+, gh CLI (authenticated), tmux, jq, node 20+. Bun, ngrok, and ao are installed by `./setup --server`.

## Project structure

```
zapbot/                              # Globally installed at ~/.claude/skills/zapbot/
├── bin/
│   ├── webhook-bridge.ts            # Bun HTTP server (port 3000)
│   ├── zapbot-publish.sh            # Plan → GitHub issue publisher
│   ├── share-link.ts                # Plannotator URL generator
│   ├── zapbot-team-init             # Onboards a repo (creates config, .env, labels)
│   └── zapbot-update-check          # VERSION check against remote
├── src/
│   ├── agents/
│   │   ├── spawner.ts               # ao spawn lifecycle, retries, prompt re-delivery
│   │   ├── heartbeat.ts             # Agent liveness checker
│   │   ├── triage.ts                # Triage role logic
│   │   ├── planner.ts               # Planner role logic
│   │   └── qe.ts                    # QE role logic
│   ├── config/
│   │   ├── loader.ts                # Parses agent-orchestrator.yaml, builds repo map
│   │   └── reload.ts                # SIGHUP config reload (parseEnvFile, reloadConfigFromDisk)
│   ├── http/
│   │   ├── error-response.ts        # Structured JSON error helper (errorResponse)
│   │   └── verify-signature.ts      # GitHub HMAC signature verification
│   ├── webhook/
│   │   └── mapper.ts                # Maps GitHub webhook payloads to typed events
│   ├── workflow-id.ts               # Canonical workflow ID from repo + issue number
│   ├── state-machine/
│   │   ├── states.ts                # State enums and label mappings
│   │   ├── transitions.ts           # Transition table definitions
│   │   ├── engine.ts                # Pure-function state machine engine
│   │   ├── events.ts                # Event type definitions
│   │   └── effects.ts               # Side effect type definitions
│   ├── store/
│   │   ├── database.ts              # Kysely + SQLite schema
│   │   ├── queries.ts               # All DB queries (workflows, agents, transitions)
│   │   ├── migrations.ts            # Schema migrations
│   │   └── dialect.ts               # Bun SQLite dialect
│   └── logger.ts                    # Structured logging (createLogger)
├── skills/
│   ├── zap/
│   │   └── SKILL.md                 # Meta-skill: onboarding + routing (/zap)
│   ├── zapbot-publish/
│   │   └── SKILL.md                 # Plan publisher with Claude orchestration
│   └── zapbot-status/
│       └── SKILL.md                 # Workflow status checker (/zapbot-status)
├── templates/
│   ├── agent-orchestrator.yaml.tmpl # Config template (templated per-repo)
│   ├── agent-rules.md.tmpl          # Base agent instructions template
│   ├── agent-rules-triage.md        # Triage agent rules
│   ├── agent-rules-planner.md       # Planner agent rules
│   ├── agent-rules-implementer.md   # Implementer agent rules (skill-aware: /simplify, /review, /investigate, /ship)
│   ├── agent-rules-qe.md            # QE agent rules (skill-aware: /review, /investigate)
│   └── zapbot-bridge.service        # Systemd unit template (placeholders: __PROJECT_DIR__, __ZAPBOT_DIR__)
├── gateway/                             # Railway-deployed webhook proxy
│   ├── src/
│   │   ├── handler.ts               # Route handler (createFetchHandler, exported for tests)
│   │   ├── index.ts                 # Server entry point, liveness sweep, graceful shutdown
│   │   └── registry.ts              # In-memory bridge registry (register, deregister, sweep)
│   ├── test/
│   │   ├── gateway-endpoints.test.ts # Gateway HTTP endpoint tests
│   │   └── registry.test.ts         # Registry unit tests
│   ├── package.json                 # Standalone Bun service (no shared deps with root)
│   ├── railway.json                 # Railway deployment config
│   └── .env.example                 # Environment variable documentation
├── test/
│   ├── state-machine.test.ts        # State machine unit tests
│   ├── store.test.ts                # Store/query unit tests
│   ├── config-loader.test.ts        # Config loader unit tests
│   ├── webhook-mapper.test.ts       # Webhook event mapping tests
│   ├── bridge-endpoints.test.ts     # Bridge HTTP endpoint tests
│   ├── error-response.test.ts       # Structured error response tests
│   ├── verify-signature.test.ts     # HMAC signature verification tests
│   ├── heartbeat.test.ts            # Agent heartbeat tests
│   ├── workflow-id.test.ts          # Workflow ID generation tests
│   ├── agent-completions.test.ts    # Agent completion function tests
│   ├── github-client.test.ts        # GitHub client tests
│   ├── effects-executor.test.ts     # Side effect retry + reconciliation tests
│   ├── systemd-service.test.ts      # Systemd service template validation tests
│   ├── plannotator-integration.test.ts # Plannotator command + callback contract tests
│   ├── config-reload.test.ts        # SIGHUP config reload + parseEnvFile tests
│   ├── multi-repo.test.ts           # Multi-repo routing, AO spawning, bridge endpoints
│   └── e2e-smoke.sh                 # E2E smoke tests
├── setup                            # Tool installer: ./setup (teammate) or ./setup --server (eng lead)
├── start.sh                         # Start bridge + AO + ngrok from a project dir
├── VERSION                          # Used by update-check
└── .gitignore
```

Each onboarded project gets (generated by `team-init`):
```
your-project/
├── .env                    # Secrets (webhook secret, repo name, bridge URL)
├── .agent-rules.md         # Agent implementation instructions
├── agent-orchestrator.yaml # AO config (templated with repo + path)
└── CLAUDE.md               # Gets zapbot routing rules appended
```

## Running tests

```bash
# Run all unit tests
bun test

# Gateway unit tests
cd gateway && bun test

# E2E smoke tests (needs gh CLI, a test repo, and running bridge)
./test/e2e-smoke.sh
```

Unit tests cover the state machine, store queries, config loader, webhook mapper,
bridge endpoints, error responses, signature verification, heartbeat, workflow IDs,
agent completions, side effect retry, systemd service template, and plannotator
integration. They run in-memory with no external dependencies. E2E tests create
real GitHub issues and need the bridge running.

## Development workflow

1. Edit code in `~/.claude/skills/zapbot/`
2. Reload config (if bridge runs as systemd service): `sudo systemctl reload zapbot-bridge`
   Or restart manually: `pkill -f "bun.*webhook-bridge" && source .env && bun bin/webhook-bridge.ts &`
3. Run tests: `bun test` (unit) or `./test/e2e-smoke.sh` (E2E, needs running bridge)
4. Test the full flow: create a plan, run `bin/zapbot-publish.sh`, add label, verify agent spawns

## Key files

| File | What it does | When to modify |
|------|-------------|----------------|
| `bin/webhook-bridge.ts` | Webhook routing, spawn triggers, callbacks, token store | Adding new webhook handlers or callback types |
| `bin/zapbot-publish.sh` | Issue creation/update logic, token registration | Changing how plans are published |
| `bin/share-link.ts` | Plannotator URL generation | Changing share link format |
| `bin/zapbot-team-init` | Per-repo onboarding | Changing what config is generated |
| `src/config/loader.ts` | Parses agent-orchestrator.yaml, repo map, per-repo secrets | Adding config options or new repo-level settings |
| `src/agents/spawner.ts` | Agent spawn lifecycle, retries, prompt re-delivery | Changing spawn behavior or adding agent options |
| `src/state-machine/engine.ts` | Pure-function state machine (apply transitions) | Adding new states or transitions |
| `src/store/queries.ts` | All database queries (workflows, agents, transitions) | Adding new queries or changing data access |
| `templates/agent-rules-*.md` | Per-role agent instructions | Changing agent behavior for a specific role |
| `src/http/error-response.ts` | Structured JSON error responses | Changing error format or adding error types |
| `src/http/verify-signature.ts` | GitHub HMAC signature verification | Changing webhook auth |
| `src/webhook/mapper.ts` | Maps GitHub webhook payloads to typed events | Adding new webhook event types |
| `src/workflow-id.ts` | Canonical workflow ID from repo + issue | Changing ID format |
| `src/effects/executor.ts` | Side effect retry with reconciliation comments | Changing retry behavior or adding effect types |
| `skills/zap/SKILL.md` | Meta-skill: onboarding + routing | Changing /zap behavior |
| `skills/zapbot-status/SKILL.md` | Workflow status checker | Changing /zapbot-status behavior |
| `templates/zapbot-bridge.service` | Systemd unit template | Changing service configuration |
| `src/config/reload.ts` | SIGHUP config reload (parseEnvFile, reloadConfigFromDisk) | Changing hot-reload behavior |
| `test/*.test.ts` | Vitest unit tests | Adding tests for new features |
| `gateway/test/*.test.ts` | Gateway service tests | Adding gateway tests |
| `test/e2e-smoke.sh` | E2E test suite | Adding integration tests |

## Adding a new repo

```bash
cd ~/new-project
~/.claude/skills/zapbot/bin/zapbot-team-init
```

That creates everything: `.env`, `agent-orchestrator.yaml`, `.agent-rules.md`, GitHub
labels, and CLAUDE.md routing. Then start zapbot from that project dir:

```bash
~/.claude/skills/zapbot/start.sh
```
