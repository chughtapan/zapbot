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

## How the webhook flow works

When someone adds the `plan-approved` label to a GitHub issue, an agent automatically
spawns and implements the plan. Here is every step:

### Setup (one-time, during `start.sh`)

1. `team-init` generates a random webhook secret and stores it in the project's `.env`:
   ```
   GITHUB_WEBHOOK_SECRET=dc3df9dc2e9b43c5d09b6648c725d1b7...
   ```

2. `start.sh` reads `.env`, starts the webhook bridge, then creates a GitHub webhook
   via `gh api repos/.../hooks --method POST` with the secret in the request body.
   GitHub stores the secret server-side (write-only, never returned via API).

3. Now GitHub and the bridge share a secret. GitHub uses it to sign every webhook
   delivery. The bridge uses it to verify signatures.

### Trigger (every time a label is added)

```
1. Someone adds "plan-approved" label on GitHub issue #24

2. GitHub creates a webhook delivery:
   - Body: {"action":"labeled","label":{"name":"plan-approved"},"issue":{"number":24}}
   - Signs it: HMAC-SHA256(body, stored_secret) → x-hub-signature-256 header
   - POSTs to the webhook URL (ngrok tunnel or static IP)

3. Webhook bridge receives the POST:
   - Reads x-hub-signature-256 header
   - Computes HMAC-SHA256(body, GITHUB_WEBHOOK_SECRET from .env)
   - Compares: if they match, the request is authentic
   - If they don't match → 401 Unauthorized

4. Bridge checks the event:
   - Is it "issues" + "labeled" + "plan-approved"? → spawn
   - Is this issue already spawned? (dedup via in-memory Map with 1h TTL) → skip
   - Otherwise → proxy the event to AO on port 3001

5. Bridge runs: Bun.spawn(["ao", "spawn", "24"])
   - Async, non-blocking. Bridge responds 202 immediately.
   - AO creates a git worktree, starts a Claude Code agent
   - Agent reads the issue body (the plan), implements it, creates a PR

6. AO handles the rest:
   - CI fails → auto-sends failure logs back to the agent
   - Reviewer requests changes → auto-forwards comments to the agent
   - PR approved + green CI → notifies the developer
```

### Security model

The webhook secret is the trust root. It's stored in one place (`.env`) and shared
with two systems:
- **GitHub** receives it when `start.sh` creates the webhook. GitHub stores it
  server-side and uses it to sign deliveries. You can't read it back via the API
  (it shows as `********`).
- **The bridge** reads it from the environment on startup. It uses it to verify
  incoming webhook signatures via HMAC-SHA256.

If the secret is compromised, an attacker can forge webhook deliveries and trigger
`ao spawn` for any issue. Mitigations: the secret is generated with `openssl rand -hex 32`
(256 bits of entropy), stored with `chmod 600`, and never committed to git (`.env`
is in `.gitignore`).

## How the plannotator callback flow works

When a teammate reviews a plan via plannotator and sends feedback, the annotations
automatically appear as a GitHub issue comment. Here is every step:

### Publishing (when developer runs `/zapbot-publish`)

```
1. zapbot-publish.sh sources the project .env to get GITHUB_WEBHOOK_SECRET
   and ZAPBOT_BRIDGE_URL (written by start.sh after ngrok starts)

2. Creates the GitHub issue with the plan body

3. Generates a plannotator share link using bin/share-link.ts:
   - Compresses the plan with deflate-raw → base64url
   - Appends callback params: ?cb=<bridge-url>/api/callbacks/plannotator/24&ct=<token>
   - The token is a random 128-bit hex string

4. Registers the token with the bridge:
   POST /api/tokens
   Authorization: Bearer <GITHUB_WEBHOOK_SECRET>
   Body: {"token":"2ca503424d36b964...","issueNumber":24}

   The bridge stores the token in an in-memory Map (expires after 24h).
   The Bearer auth prevents random internet users from registering tokens.

5. Edits the issue body to include the share link with callback params
```

### Reviewing (when teammate clicks the plannotator link)

```
1. Teammate opens the plannotator share link in their browser:
   https://share.plannotator.ai/#<compressed-plan>?cb=https://abc.ngrok.dev/...&ct=2ca503...

2. Plannotator UI loads in the browser. The plan is decompressed client-side.
   Teammate annotates the plan (delete, insert, replace, comment).

3. Teammate clicks "Send Feedback". Plannotator's JavaScript reads ?cb= and ?ct=
   from the URL and POSTs directly from the browser:
   POST https://abc.ngrok.dev/api/callbacks/plannotator/24
   Body: {"action":"feedback","token":"2ca503...","annotated_url":"https://share.plannotator.ai/#<plan-with-annotations>"}

4. Webhook bridge receives the POST:
   - Looks up the token in its in-memory Map
   - Verifies it matches issue #24
   - Deletes the token (one-time use)
   - Decompresses the annotations from the annotated_url hash
   - Formats them as readable markdown
   - Posts as a GitHub issue comment via: gh issue comment 24 --body "..."

5. The annotations appear on the GitHub issue. The developer (and the agent,
   when it eventually reads the issue) can see the feedback inline.
```

### Why approval is separate from callbacks

Plannotator callbacks sync *feedback*, not *approval*. Anyone with the share link
can send feedback (the token proves they came from a legitimate plannotator session,
not that they have authority to approve). Approval is adding the `plan-approved`
label on GitHub, which requires write access to the repo. This matches GitHub's
existing permission model.

## Components

### webhook-bridge (`bin/webhook-bridge.ts`)

Bun HTTP server. Single entry point for all external traffic.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/webhooks/github` | POST | GitHub webhook receiver. HMAC verified. `issues.labeled` with `plan-approved` triggers `ao spawn`. All other events proxied to AO. |
| `/api/callbacks/plannotator/:issueNum` | POST | Plannotator annotation callback. Decompresses annotations, posts as GitHub issue comment. One-time token auth. |
| `/api/tokens` | POST | Token registration for plannotator callbacks. Requires Bearer auth (webhook secret). |
| `/healthz` | GET | Health check. |
| `/*` | * | Proxy to agent-orchestrator on port 3001. |

### zapbot-publish (`bin/zapbot-publish.sh`)

Bash script that publishes a plan as a GitHub issue. Called by the Claude Code skill
or directly from the command line. Sources `.env` from the project root for credentials
and bridge URL.

### share-link (`bin/share-link.ts`)

Generates plannotator share URLs. Compresses plan content with deflate-raw, encodes as
base64url, produces a `share.plannotator.ai` URL. Optionally appends
`?cb=<callback_url>&ct=<token>` for annotation sync.

### zapbot-team-init (`bin/zapbot-team-init`)

Onboards a project repo. Creates `.agent-rules.md`, `agent-orchestrator.yaml` (templated
with the repo name and path), `.env` (with random webhook secret), GitHub labels, and
CLAUDE.md routing rules. Run once per project.

### agent-orchestrator (external dependency)

[Composio agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) handles
worktree creation/cleanup, Claude Code agent lifecycle, CI failure auto-fix, review comment
forwarding, session recovery, and the web dashboard. Configured via
`agent-orchestrator.yaml` in each project.

## The `.env` file

Single source of truth for secrets and configuration. Generated by `team-init`, read by
`start.sh` and `zapbot-publish.sh`. Never committed to git.

```
GITHUB_WEBHOOK_SECRET=<random 256-bit hex>     # shared with GitHub + bridge
ZAPBOT_REPO=owner/repo                          # auto-detected or explicit
ZAPBOT_BRIDGE_URL=https://abc.ngrok.dev          # written by start.sh after ngrok starts
```

The key ordering constraint: `.env` must be sourced BEFORE reading env vars in every
script. Both `start.sh` and `zapbot-publish.sh` source `.env` as their first action,
then read `ZAPBOT_BRIDGE_URL`, `GITHUB_WEBHOOK_SECRET`, etc. from the environment.
This ensures values from `.env` take precedence over any previously set env vars.

## Design decisions

**Webhook bridge instead of AO orchestrator agent.** AO's GitHub SCM plugin doesn't
handle `issues` events, only PR/CI/review events for existing sessions. Using an LLM
to poll for labeled issues is wasteful and fragile. A deterministic webhook handler is
faster, cheaper, and more reliable.

**Plans in GitHub issues, not PRs.** Issues are the natural home for plans. PRs are for
code. AO's GitHub tracker already reads issues as tasks. This separation keeps the
review surface (plan) cleanly separated from the implementation surface (code).

**Plannotator for visual review, GitHub for approval.** Plannotator provides a better
review UX (visual annotations, diffs). But approval is authorization, and authorization
should go through GitHub's permission model (who can add labels). Plannotator callbacks
sync feedback, not approval decisions.

**Server-side token storage.** Callback tokens stored in-memory on the bridge, not in
the GitHub issue body. Issue bodies are readable by all repo collaborators. Tokens
expire after 24 hours. Spawned-issue dedup also uses in-memory storage with 1-hour TTL
so re-approving after a plan update works.

**One secret, two uses.** `GITHUB_WEBHOOK_SECRET` authenticates both GitHub webhook
deliveries (via HMAC-SHA256 signature) and token registration API calls (via Bearer
header). This is a pragmatic choice for an internal tool: one secret to manage, stored
in one place. For production, you'd use separate secrets for each trust boundary.
