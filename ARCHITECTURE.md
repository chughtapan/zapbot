# Zapbot Architecture

## Overview

Zapbot implements an SDS-inspired collaborative state machine that manages the
lifecycle of code changes from intent to deployment. It uses a two-level model:
parent issues represent high-level intent, and sub-issues represent independent
workstreams that each follow their own lifecycle.

## Two-Level State Machine

### Parent Issue (Epic-Level)

```
┌─────────┐        ┌──────────┐        ┌───────────┐
│ TRIAGE  │───────>│ TRIAGED  │───────>│ COMPLETED │
└─────────┘        └──────────┘        └───────────┘
     │                   │
triage_agent        tracks sub-issue
decomposes          progress; auto-
into sub-issues     completes when
                    all subs done
```

### Sub-Issue (Task-Level)

```
┌──────────┐   ┌────────┐   ┌──────────┐   ┌──────────────┐   ┌─────────────┐   ┌──────────────┐   ┌──────┐
│ PLANNING │──>│ REVIEW │──>│ APPROVED │──>│ IMPLEMENTING │──>│ DRAFT_REVIEW│──>│  VERIFYING   │──>│ DONE │
└──────────┘   └────────┘   └──────────┘   └──────────────┘   └─────────────┘   └──────────────┘   └──────┘
     ^             |                              ^                  │                   │
     |        [revise]                            |             [ready for          [tests fail]
     └─────────────┘                        [changes req'd]    review clicked]     qe retries
                                            human iterates     spawns qe_agent     or escalates
                                            on draft PR
```

## State Definitions

### Parent Issue States

| State | GitHub Label | Description |
|-------|-------------|-------------|
| `TRIAGE` | `triage` | Triage agent analyzing intent, creating sub-issues |
| `TRIAGED` | `triaged` | Sub-issues created, work in progress |
| `COMPLETED` | (closed) | All sub-issues in terminal state |
| `ABANDONED` | `abandoned` | Human stopped the workflow |

### Sub-Issue States

| State | GitHub Label | Description |
|-------|-------------|-------------|
| `PLANNING` | `planning` | Human or agent drafting a plan |
| `REVIEW` | `review` | Plan under review via plannotator |
| `APPROVED` | `plan-approved` | Plan approved, ready for implementation |
| `IMPLEMENTING` | `implementing` | Implementer agent writing code, creating draft PR |
| `DRAFT_REVIEW` | `draft-review` | Draft PR open, humans reviewing with agent |
| `VERIFYING` | `verifying` | QE agent running tests, verifying, shipping |
| `DONE` | (closed) | PR merged, sub-issue closed |
| `ABANDONED` | `abandoned` | Human stopped this sub-issue |

## Transition Tables

### Parent Issue Transitions

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `TRIAGE` | `TRIAGED` | `triage_complete` | TriageAgent |
| `TRIAGED` | `COMPLETED` | `all_subs_done` | System |
| *(any)* | `ABANDONED` | `label:abandoned` | Author, Approver |

### Sub-Issue Transitions

| From | To | Trigger | Actor |
|------|----|---------|-------|
| `PLANNING` | `REVIEW` | `plan_published` | Author, PlannerAgent |
| `REVIEW` | `APPROVED` | `label:plan-approved` | Reviewer, Approver |
| `REVIEW` | `PLANNING` | `annotation_feedback` | Reviewer |
| `APPROVED` | `IMPLEMENTING` | `spawn_agent` | System |
| `IMPLEMENTING` | `DRAFT_REVIEW` | `draft_pr_opened` | System |
| `DRAFT_REVIEW` | `DRAFT_REVIEW` | `changes_requested` | Reviewer |
| `DRAFT_REVIEW` | `VERIFYING` | `pr_ready_for_review` | Reviewer, Author |
| `VERIFYING` | `DONE` | `verified_and_shipped` | QEAgent |
| `VERIFYING` | `DRAFT_REVIEW` | `verification_failed` | QEAgent |
| *(any)* | `ABANDONED` | `label:abandoned` | Author, Approver |

## Data Model

SQLite database at `~/.zapbot/state.db` managed via Kysely migrations.

### Tables

- **workflows** — Tracks each issue's current state, level (parent/sub), and lineage
- **agent_sessions** — Agent lifecycle: role, status, worktree, PR number, heartbeat
- **transitions** — Audit log of every state transition with metadata

## Agent Roles

| Agent | Spawned At | Creates |
|-------|-----------|---------|
| Triage | Parent enters TRIAGE | Sub-issues with scoped descriptions |
| Planner | Sub-issue enters PLANNING | Implementation plan, published via plannotator |
| Implementer | Sub-issue enters APPROVED | Draft PR with code changes |
| QE | Draft PR marked ready | Merges PR after verification |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| POST | `/api/webhooks/github` | GitHub webhook receiver |
| GET | `/api/workflows/:issueNumber` | Workflow state + sub-issues + agents |
| GET | `/api/workflows/:issueNumber/history` | Transition audit trail |
| POST | `/api/agents/:agentId/heartbeat` | Agent liveness ping |
| POST | `/api/agents/:agentId/complete` | Agent completion signal |
| POST | `/api/callbacks/plannotator/:issueNumber` | Plannotator callback |
| POST | `/api/tokens` | Plannotator callback token registration |

All error responses use structured JSON via `src/http/error-response.ts` (`{ error, message, status }`).

## Multi-Repo Routing

The bridge supports multiple repos from a single instance via `src/config/loader.ts`:

1. **Config loading:** Parses `agent-orchestrator.yaml` to build a `RepoMap` (repo full_name → project config). Falls back to `ZAPBOT_REPO` env var for single-repo backward compat.
2. **Per-repo HMAC:** Each project can specify a `secretEnvVar` in its SCM config. `resolveWebhookSecret()` checks the per-repo env var first, falls back to shared `ZAPBOT_API_KEY`.
3. **Repo rejection:** Webhooks from repos not in the `RepoMap` are rejected with 403 (only when a config is loaded).
4. **Project-scoped spawning:** `executeSideEffects()` resolves the project name from the repo map and passes it to `ao spawn` via `AO_PROJECT_ID` and `AO_CONFIG_PATH` environment variables. AO uses `AO_PROJECT_ID` to select the correct project and `AO_CONFIG_PATH` to find the agent-orchestrator.yaml.
5. **Callback tokens:** Plannotator tokens are stored locally with repo context (`callbackTokens` Map with 24h TTL). Tokens are scoped to the specific issue number, so a token for issue #5 cannot be replayed against issue #10. Callbacks resolve repo via: token store → request body → `ZAPBOT_REPO` env var.

## Gateway Service

The gateway (`gateway/`) is a lightweight HTTP proxy deployed to Railway with a static HTTPS URL.
It replaces ngrok as the public endpoint for GitHub webhooks.

```
GitHub ──POST──> Gateway (Railway) ──forward──> Bridge (local)
                    │
              Routes by repo
              (in-memory registry)
```

### Gateway Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks/github` | Forward webhook to registered bridge |
| POST | `/api/bridges/register` | Register a bridge (requires `GATEWAY_SECRET`) |
| DELETE | `/api/bridges/register` | Deregister a bridge |
| GET | `/healthz` | Health check with bridge status |

### Design Decisions

- Gateway does NOT verify GitHub HMAC signatures. It passes `x-hub-signature-256` through to the bridge, which already has per-repo secret verification.
- Gateway is a dumb proxy that routes based on `repository.full_name` in the webhook payload.
- Multiple bridges can register for different repos on the same gateway.
- Liveness sweep pings registered bridges periodically and marks unresponsive ones inactive. Bridges inactive for 5x the timeout are reaped from memory.

### Deployment

- Runs on Railway via `railway.json` (Nixpacks builder, Bun runtime)
- Config via env vars: `GATEWAY_SECRET` (required), `PORT`, `LIVENESS_INTERVAL_MS`, `STALE_TIMEOUT_MS`, `FORWARD_TIMEOUT_MS`
- Static domain: `zapbot-gateway.up.railway.app` (or custom)

## Operations

### Systemd Service

`setup --server` generates a systemd unit file from `templates/zapbot-bridge.service`.
Install with `sudo cp zapbot-bridge.service /etc/systemd/system/ && sudo systemctl enable --now zapbot-bridge`.
The service auto-restarts on crash (`Restart=always`, 5s delay).

### Config Hot-Reload (SIGHUP)

The bridge handles `SIGHUP` to reload config without downtime (same pattern as nginx/PostgreSQL):
1. Re-sources `.env` and re-parses `agent-orchestrator.yaml`
2. Validates: YAML must parse, `ZAPBOT_API_KEY` must be non-empty, at least one repo configured
3. If valid: swaps `WEBHOOK_SECRET` and `repoMap` in memory, logs summary
4. If invalid: logs error with details, keeps old config running

Trigger via `systemctl reload zapbot-bridge` or `kill -HUP <pid>`.

### Side Effect Retry

GitHub API side effects (add_label, remove_label, post_comment, etc.) retry once on failure
with a 2-second delay. If the retry also fails, a reconciliation comment is posted on the
issue listing which effects failed and what state the database expects. This prevents
silent state divergence between the DB and GitHub.

Logic lives in `src/effects/executor.ts`.

### GitHub Comments

Every state transition posts a `**Zapbot:**` prefixed comment on the GitHub issue explaining
what happened and what to do next. Comments include who approved (with @mention), what agent
is spawning, and guidance for the next step. This gives users visibility into the pipeline
without needing to check bridge logs. Defined in `src/state-machine/transitions.ts`.

## Extracted Modules

| Module | Description |
|--------|-------------|
| `src/http/error-response.ts` | Structured JSON error helper (`errorResponse`) used by all API endpoints |
| `src/http/verify-signature.ts` | GitHub HMAC signature verification (extracted for testability) |
| `src/webhook/mapper.ts` | Maps raw GitHub webhook payloads to typed internal events |
| `src/workflow-id.ts` | Canonical workflow ID generation from repo + issue number |
| `src/effects/executor.ts` | Side effect retry with reconciliation comments for GitHub API failures |
| `src/config/reload.ts` | SIGHUP config reload: `parseEnvFile()` + `reloadConfigFromDisk()` |

## Edge Cases

- **Webhook dedup:** Workflow-creation paths deduplicate to prevent double-spawning agents from rapid webhook deliveries
- **Self-label loops:** Bridge ignores label events authored by the bot itself
- **Draft PR loop convergence:** Max 3 cycles of DRAFT_REVIEW <-> VERIFYING before ABANDONED
- **Stale agents:** Heartbeat timeout after 15 min triggers failure + human notification
- **Race conditions:** `BEGIN IMMEDIATE` SQLite transactions serialize per-workflow writes
- **Non-draft PR fallback:** Non-draft PR from implementer skips DRAFT_REVIEW
- **Parent completion:** Triggers when all sub-issues reach terminal state (DONE or ABANDONED)
- **Startup recovery:** Bridge scans active workflows on startup, re-spawns agents for stuck workflows (all agents dead)
- **Webhook cleanup:** `start.sh` tracks webhook IDs and deactivates them on shutdown to avoid stale deliveries
- **Null delivery ID:** Logged as warning for visibility on manual API calls; request still processed (no dedup)
- **Atomic file writes:** team-init and start.sh use mktemp + trap to prevent config corruption on crash
- **Systemd conflict guard:** start.sh exits with warning if the systemd service is already active
