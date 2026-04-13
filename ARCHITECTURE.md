# Architecture

## System overview

```
Developer Machine              GitHub                  Server (GCP or local)
┌──────────────────┐                                   ┌──────────────────────┐
│ Claude Code      │                                   │                      │
│ + plannotator    │    ┌──────────────┐               │  webhook-bridge      │
│ + /zapbot-publish│───▶│  Issue #N     │──webhook────▶│  (port 3000)         │
│                  │    │  + plan body  │               │  │                  │
│                  │    │  + share link │               │  ├─ issues.labeled   │
│                  │    │  + labels     │               │  │  → ao spawn      │
│                  │    └──────────────┘               │  │                  │
│                  │                                   │  ├─ callbacks        │
│                  │                                   │  │  → gh comment    │
│                  │    ┌──────────────┐               │  │                  │
│                  │◀───│  PR #M       │◀──────────────│  └─ proxy → AO     │
│  review, merge   │    └──────────────┘               │                      │
└──────────────────┘                                   │  agent-orchestrator  │
                                                       │  (port 3001)         │
                                                       │  ├─ worktrees       │
                                                       │  ├─ Claude Code     │
                                                       │  ├─ CI auto-fix     │
                                                       │  └─ dashboard       │
                                                       └──────────────────────┘
```

## Components

### webhook-bridge (`bin/webhook-bridge.ts`)

Bun HTTP server. Single entry point for all external traffic. Routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/webhooks/github` | POST | GitHub webhook receiver. HMAC verified. `issues.labeled` with `plan-approved` triggers `ao spawn`. All other events proxied to AO. |
| `/api/callbacks/plannotator/:issueNum` | POST | Plannotator annotation callback. Decompresses annotations, posts as GitHub issue comment. One-time token auth. |
| `/api/tokens` | POST | Token registration for plannotator callbacks. Requires Bearer auth (webhook secret). |
| `/healthz` | GET | Health check. |
| `/*` | * | Proxy to agent-orchestrator on port 3001. |

Security: HMAC-SHA256 for GitHub webhooks. Bearer token for `/api/tokens`. One-time tokens for callbacks. Issue numbers validated as positive integers before any shell interaction. Async `Bun.spawn` (no `execSync`). Dedup via in-memory Set.

### zapbot-publish (`bin/zapbot-publish.sh`)

Bash script that publishes a plan as a GitHub issue. Called by the Claude Code skill or directly from the command line.

Flow: read plan file → create issue (to get issue number) → generate share link with real callback URL → edit issue with final body → register callback token with bridge.

### share-link (`bin/share-link.ts`)

Generates plannotator share URLs. Compresses plan content with deflate-raw, encodes as base64url, produces a `share.plannotator.ai` URL. Optionally appends `?cb=<callback_url>&ct=<token>` for annotation sync.

### agent-orchestrator (external dependency)

[Composio agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) handles the hard parts: git worktree creation/cleanup, Claude Code agent lifecycle, CI failure auto-fix, review comment forwarding, session recovery, and the web dashboard. Configured via `agent-orchestrator.yaml`.

## Data flow

```
1. Developer creates plan in Claude Code
2. /zapbot-publish creates GitHub issue with plan body + plannotator share link
3. Team reviews via plannotator (annotations sync back as issue comments)
4. Authorized team member adds "plan-approved" label
5. GitHub webhook fires → webhook-bridge receives it
6. Bridge calls ao spawn <issue#> (async, with dedup)
7. AO creates git worktree, starts Claude Code agent
8. Agent reads issue body (plan), implements, creates PR
9. AO handles CI failures (auto-sends to agent) and review comments
10. Developer reviews PR, merges
```

## Design decisions

**Webhook bridge instead of AO orchestrator agent.** AO's GitHub SCM plugin doesn't handle `issues` events, only PR/CI/review events for existing sessions. Using an LLM to poll for labeled issues is wasteful and fragile. A deterministic webhook handler is faster, cheaper, and more reliable.

**Plans in GitHub issues, not PRs.** Issues are the natural home for plans. PRs are for code. AO's GitHub tracker already reads issues as tasks. This separation keeps the review surface (plan) cleanly separated from the implementation surface (code).

**Plannotator for visual review, GitHub for approval.** Plannotator provides a better review UX (visual annotations, diffs). But approval is authorization, and authorization should go through GitHub's permission model (who can add labels). Plannotator callbacks sync feedback, not approval decisions.

**Server-side token storage.** Callback tokens stored in-memory on the bridge, not in the GitHub issue body. Issue bodies are readable by all repo collaborators. Tokens expire after 24 hours.
