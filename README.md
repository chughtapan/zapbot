# Zapbot

Zapbot is a thin GitHub webhook control bridge for the AO runtime (`ao`).

GitHub keeps the durable task record. Zapbot verifies webhooks, checks repo
permissions, and forwards control events into a persistent AO orchestrator
session for each configured project.

## Plain-language terms

- `ao` is the CLI/runtime zapbot uses to start and keep agent sessions alive.
- An orchestrator session is the always-on AO session for one project. It reads
  GitHub events, chooses what to do next, and delegates work.
- Worker sessions are short-lived AO sessions spawned for one issue or task.
- MoltZap is the live messaging layer attached to an AO session. Zapbot uses
  it so the orchestrator and workers can coordinate in real time.

## Runtime flow

1. GitHub sends `issue_comment` webhooks to `/api/webhooks/github`.
2. Zapbot verifies the HMAC and detects an eligible direct `@zapbot` mention.
3. Zapbot checks that the commenter has write access.
4. Zapbot ensures the project's AO orchestrator session is running.
5. Zapbot forwards the GitHub control event into that orchestrator session.
6. The orchestrator decides whether to spawn worker sessions with
   `bun run bin/ao-spawn-with-moltzap.ts <issue-number>`.

## Canonical commands

### `setup --server`

Run this from the zapbot checkout on the bridge host:

```bash
./setup --server
```

This installs zapbot's repo dependencies and the AO runtime needed on the
server side. If Bun is missing, setup installs it too.

### `zapbot-team-init`

Use this from the project checkout zapbot should operate on:

```bash
/path/to/zapbot/bin/zapbot-team-init owner/repo
```

That creates canonical local operator config under:

```text
~/.zapbot/projects/<project-key>/project.json
```

`zapbot-team-init` does not write checkout-local `.env` or
`agent-orchestrator.yaml`. To add another repo later, use:

```bash
/path/to/zapbot/bin/zapbot-team-init --add-repo owner/other-repo
```

### Start the stack with `start.sh .`

Run this from the project checkout after `zapbot-team-init` has created the
canonical `~/.zapbot` project config:

```bash
/path/to/zapbot/start.sh .
```

`start.sh` resolves the project by checkout path, loads
`~/.zapbot/projects/<project-key>/project.json`, materializes the AO runtime
config it needs, then starts AO on `bridge.aoPort` and the webhook bridge on
`bridge.port`.

The README examples use `start.sh` in a foreground shell so you can see the
readiness receipt and stop local or demo startup with `Ctrl+C`. For always-on
deployment, keep the same `~/.zapbot` config and run zapbot under your normal
process supervisor or service manager.

`start.sh` treats ingress as an explicit mode:

- `local-only` runs the stack without public GitHub ingress.
- `github-demo` requires a reachable public bridge URL and fails closed if the
  bridge URL is missing or unreachable.

If `ZAPBOT_GATEWAY_URL` is unset or only whitespace, `start.sh` stays
`local-only`. In demo mode, set `ZAPBOT_GATEWAY_URL` and `ZAPBOT_BRIDGE_URL`
before startup.

### GitHub comment ingress

Zapbot only reacts to issue comments that directly mention `@zapbot` outside
quoted/code-fenced content.

Zapbot forwards the full raw comment body to AO together with repo, issue,
comment, and delivery context. The bridge does not maintain a command table and
does not splice raw comment text into a shell command.

Example requests:

- `@zapbot please plan the next lane for this issue`
- `@zapbot investigate why signed comments still fail here`
- `@zapbot summarize what is blocking this PR and decide the next step`

## MoltZap

Zapbot provisions MoltZap credentials for orchestrator and worker sessions by
registering fresh runtime identities.

The MoltZap Claude launcher path is Bun/TypeScript-owned. Worker bring-up does
not require a separate `python3` shim.

| Env | Meaning |
|---|---|
| `ZAPBOT_MOLTZAP_SERVER_URL` + `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` | register a fresh MoltZap agent for each spawned worker and orchestrator session |
| `ZAPBOT_MOLTZAP_ALLOWED_SENDERS` | optional comma-separated sender allowlist forwarded to the session runtime |

If `ZAPBOT_MOLTZAP_SERVER_URL` is unset, zapbot runs without MoltZap.

Worker env posture:

- In token mode, zapbot forwards the configured GitHub token into AO child
  sessions as `GH_TOKEN`.
- In GitHub App mode, zapbot forwards the GitHub installation token into AO
  child sessions as `GH_TOKEN` so spawned workers can use GitHub on behalf of
  the repo. That token stays inside the local trust boundary: the bridge
  process and its AO child processes on the operator machine. It is not meant
  to cross into GitHub, MoltZap messages, or published artifacts.
- Zapbot forwards `MOLTZAP_*` only when MoltZap is configured.
- Zapbot does **not** forward `ZAPBOT_API_KEY`, `ZAPBOT_WEBHOOK_SECRET`, or
  `GITHUB_APP_PRIVATE_KEY` into AO child processes.

## Bridge host setup

### Prerequisites

Bridge operators need:

- `git`
- `gh` authenticated via `gh auth login`
- `node`, `tmux`, and `jq`

### Bootstrap one repo

1. Clone this repo on the bridge host and run server setup from the zapbot
   checkout:

```bash
cd /path/to/zapbot
./setup --server
```

2. Change into the project checkout AO should operate in, then generate the
   canonical local zapbot config for that repo:

```bash
cd /path/to/your-project
/path/to/zapbot/bin/zapbot-team-init owner/repo
```

This creates:

- `~/.zapbot/projects/<project-key>/project.json` - the canonical local
  operator config for this checkout
- `~/.zapbot/projects/<project-key>/state/` - the canonical local state
  directory for managed-session registry data

That config file contains local secrets and bearer values generated by
`zapbot-team-init`, including the webhook secret and bridge API key. Keep it
local to the operator machine and do not copy it into the repo checkout.

3. Edit `~/.zapbot/projects/<project-key>/project.json` and fill in GitHub auth
   plus any optional gateway or MoltZap config you need:

```json
{
  "bridge": {
    "port": 3000,
    "aoPort": 3001,
    "publicUrl": null,
    "gatewayUrl": null,
    "gatewaySecret": null,
    "apiKey": "generated-by-team-init",
    "botUsername": "zapbot[bot]",
    "logLevel": "info"
  },
  "github": {
    "mode": "token",
    "token": "fill-me"
  },
  "moltzap": {
    "serverUrl": null,
    "registrationSecret": null,
    "allowedSenders": null
  }
}
```

Switch `github.mode` to `app` and fill `appId`, `installationId`, and
`privateKeyPem` if you want GitHub App auth instead of token auth.

Hosted/platform deployments are different: do not create local project files in
the checkout. Export `ZAPBOT_*` and GitHub auth env from your deployment
environment, typically backed by GitHub repo secrets.

4. Start the operator stack from the same project checkout in a foreground
   shell:

```bash
cd /path/to/your-project
/path/to/zapbot/start.sh .
```

## Startup receipt

When startup succeeds, you should see output like this:

```text
=== Starting Zapbot ===
Mode:      github-demo
Project: /path/to/your-project
Repos:   owner/repo
AO ready on port 3001
Bridge ready on port 3000

================================================
  Zapbot is running!
================================================
  Mode:      github-demo
  Bridge:    http://localhost:3000
  Dashboard: http://localhost:3001
  Gateway:   https://gateway.example.com
  Public:    https://bridge.example.com
  Publish:   bash /path/to/zapbot/bin/zapbot-publish.sh <plan-file>
  Logs: /tmp/zapbot-{ao,bridge}.log
  Press Ctrl+C to stop everything.
================================================
```

If `ZAPBOT_GATEWAY_URL` is unset or blank, the receipt switches to
`local-only` mode and the `Gateway:` / `Public:` lines show local-only
markers. If the readiness lines do not appear earlier in the shell output,
check `/tmp/zapbot-ao.log` and `/tmp/zapbot-bridge.log`.

## Managed session lifecycle

Lifecycle ownership is explicit and canonicalized under `~/.zapbot`. Zapbot
writes a registry file at:

```text
~/.zapbot/projects/<project-key>/state/.zapbot-managed-sessions.json
```

Only the sessions recorded there are eligible for automation.

Terms used in this section:

- A session is a live AO runtime session.
- A registry record is one JSON row in the managed-session registry file.
- An orchestrator session is the long-lived AO session for one project.
- A worker session is a short-lived AO session spawned for one issue or task.
- A managed session is a registry record tagged `managed: true` and owned by
  `zapbot`.
- `github-demo` mode means `start.sh` is running with public GitHub ingress,
  not `local-only` mode.

Current lifecycle behavior:

- `start.sh` retries after a duplicate orchestrator only when the duplicate
  matches a zapbot-managed orchestrator record in the project registry.
- `bin/ao-spawn-with-moltzap.ts` records each spawned worker in that same
  registry once the worker metadata exposes `worktree` and `tmuxName`.
- `Ctrl+C` in the `start.sh` shell stops only the bridge and AO parent
  processes it launched. It does not scan tmux names and does not kill sessions
  by heuristic.
- Manual or pre-existing tmux sessions are out of scope. If a session is not in
  the managed-session registry, zapbot must not stop or garbage-collect it.
- Only GitHub users with write access to the repo can drive the `@zapbot ...`
  control path. Random issue commenters are not part of the control boundary.
- Bridge secrets such as `ZAPBOT_API_KEY`, `ZAPBOT_WEBHOOK_SECRET`, and
  `GITHUB_APP_PRIVATE_KEY` stay on the bridge host and are not forwarded into
  AO child sessions.

### Lifecycle inspection entrypoints

Supported lifecycle inspection and teardown entrypoints today are the
canonical local registry queried with `jq` and AO's own `ao status --json`
output. Start with those views before any manual attach or teardown; there is
no separate zapbot lifecycle CLI in this README.

From the project checkout:

```bash
PROJECT_KEY=your-project
REGISTRY="$HOME/.zapbot/projects/$PROJECT_KEY/state/.zapbot-managed-sessions.json"

jq '.records[] | {session: .tag.sessionName, scope: .tag.scope, phase: .phase, tmux: .tmuxName, worktree: .worktree}' \
  "$REGISTRY"

ao status --json | jq '.[] | {name, role, status}'
```

Safe manual cleanup rule:

- Start from the managed-session registry, not from guessed tmux names.
- If you inspect a live session, use the `tmuxName` recorded in that registry.
- If a session is manual or absent from the registry, leave it alone.
- `README.md` is the operator contract for startup, inspection, and teardown.
  `ARCHITECTURE.md` is the module map and lifecycle rationale.

Registry field meanings:

- `tag.sessionName` is the AO session identity.
- `tag.scope` tells you whether the record is for the orchestrator, a worker,
  or another managed surface.
- `phase` is zapbot's lifecycle view of the record, not a promise that the
  session is still live.
- `tmuxName` is the attach target when zapbot knows one.
- `worktree` is the checkout path that session was launched from.

## Dummy-project demo

This demo assumes you want `github-demo` mode with a reachable public bridge
URL and a reachable MoltZap server. It fails closed if the bridge URL is
missing or unreachable. Use a throwaway private repo for this demo; the final
cleanup step deletes it.

1. Create a dummy project checkout, initialize zapbot, and start the stack:

```bash
ZAPBOT_DIR=/absolute/path/to/zapbot
DEMO_OWNER="$(gh api user -q .login)"
DEMO_REPO="$DEMO_OWNER/zapbot-demo"
mkdir -p /tmp/zapbot-demo
cd /tmp/zapbot-demo
git init -b main
git commit --allow-empty -m 'chore: bootstrap demo repo'
gh repo create "$DEMO_REPO" --private --source=. --remote=origin --push
"$ZAPBOT_DIR/bin/zapbot-team-init" "$DEMO_REPO"
```

2. Before `start.sh .`, edit the canonical config file for this demo project.
   The default project key is the checkout basename, so for `/tmp/zapbot-demo`
   the file is:

```text
$HOME/.zapbot/projects/zapbot-demo/project.json
```

- Choose exactly one GitHub auth path for the demo:
  - Personal/token path:

    ```json
    "github": { "mode": "token", "token": "ghp_or_github_pat_with_repo_access" }
    ```

  - GitHub App path:

    ```json
    "github": {
      "mode": "app",
      "appId": "123456",
      "installationId": "78901234",
      "privateKeyPem": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
    }
    ```

- `gh auth status` should show you are logged in, because the demo creates the
  repo and issues with the GitHub CLI.
- `bridge.apiKey` and each route `webhookSecret` are already generated by
  `zapbot-team-init`.
- If `bridge.gatewayUrl` is `null`, `start.sh` stays `local-only` and
  will not run the GitHub-backed demo path.
- If you use token auth, it should be a token that can create the
  throwaway repo and comment on its issues. If you use GitHub App env instead,
  those values come from the App you configured for this demo repo.

Demo config checklist inside `project.json`:

| Field | Required | Example | Where it comes from | Failure shape if wrong |
|---|---|---|---|---|
| `github.token` | one auth path only | `ghp_...` | GitHub token or PAT with repo access | issue/repo operations fail |
| `github.appId` / `github.installationId` / `github.privateKeyPem` | one auth path only | `123456`, `78901234`, PEM text | GitHub App configured for the demo repo | installation token broker fails |
| `bridge.gatewayUrl` | yes for `github-demo` | `https://gateway.example.com` | your public gateway/proxy URL | startup stays `local-only` or demo cannot ingress |
| `bridge.publicUrl` | yes for `github-demo` | `https://bridge.example.com` | the public URL that reaches this bridge host | startup exits `missing` or `unreachable` |
| `moltzap.serverUrl` | yes for this demo | `wss://moltzap.example/ws` | your MoltZap server | workers come up without live MoltZap coordination |
| `moltzap.registrationSecret` | yes for this demo | shared registration secret | your MoltZap deployment | worker provisioning fails |

```bash
"$ZAPBOT_DIR/start.sh" .
```

Expected startup receipts:

- success: the shell receipt shows `Mode: github-demo`
- missing public URL: `start.sh` exits with `ZAPBOT_BRIDGE_URL is missing`
- unreachable public URL: `start.sh` exits with `ZAPBOT_BRIDGE_URL is unreachable`
- after successful startup, `curl -fsS "${ZAPBOT_BRIDGE_URL%/}/healthz"` should
  return `ok`
- before using `@zapbot`, verify your GitHub actor has repo write access:

```bash
gh api "repos/$DEMO_REPO/collaborators/$DEMO_OWNER/permission" -q .permission
```

Expected values are `admin`, `maintain`, or `write`.

3. Open two issues in that repo, then comment on each one:

```bash
ISSUE_A_URL="$(gh issue create --repo "$DEMO_REPO" --title 'agent A' --body 'dummy')"
ISSUE_B_URL="$(gh issue create --repo "$DEMO_REPO" --title 'agent B' --body 'dummy')"
ISSUE_A="${ISSUE_A_URL##*/issues/}"
ISSUE_B="${ISSUE_B_URL##*/issues/}"
gh issue comment "$ISSUE_A" --repo "$DEMO_REPO" --body '@zapbot please plan the next lane for this issue'
gh issue comment "$ISSUE_B" --repo "$DEMO_REPO" --body '@zapbot investigate why this second issue is still blocked'
```

4. What you should see:

- one persistent orchestrator session handling both GitHub events
- one MoltZap-linked worker session for `ISSUE_A`
- one MoltZap-linked worker session for `ISSUE_B`
- the orchestrator talking to each worker over MoltZap, then writing durable
  output back to GitHub
- only comments from GitHub users with write access to the repo should drive
  this path

5. Confirm the local lifecycle state from the project checkout:

```bash
PROJECT_KEY=zapbot-demo
REGISTRY="$HOME/.zapbot/projects/$PROJECT_KEY/state/.zapbot-managed-sessions.json"

jq '.records[] | {session: .tag.sessionName, scope: .tag.scope, phase: .phase, tmux: .tmuxName}' \
  "$REGISTRY"

ORCH_TMUX="$(jq -r '.records[] | select(.tag.scope=="orchestrator") | .tmuxName' "$REGISTRY")"
tmux attach -t "$ORCH_TMUX"
```

You should see exactly one orchestrator record and two worker records in the
managed-session registry. If you want to inspect the workers too, use the
registry values instead of guessing session names:

```bash
jq -r '.records[] | select(.tag.scope=="worker") | .tmuxName' \
  "$REGISTRY"
```

If `tmuxName` is missing for a record, do not guess. Treat that as a signal to
inspect `ao status --json` and `/tmp/zapbot-ao.log` instead of attaching by
hand.

Single-command questions to ask during the demo:

| Question | Command |
|---|---|
| Is the public bridge up? | `curl -fsS "$(jq -r '.bridge.publicUrl' "$HOME/.zapbot/projects/zapbot-demo/project.json")/healthz"` |
| Which sessions does zapbot think it owns? | `jq '.records[] | {session: .tag.sessionName, scope: .tag.scope, phase: .phase}' "$REGISTRY"` |
| Which AO sessions are actually live? | `ao status --json | jq '.[] | {name, role, status}'` |
| Which tmux session should I attach to? | `jq -r '.records[] | select(.tag.scope=="orchestrator") | .tmuxName' "$REGISTRY"` |

If the counts do not match:

- no orchestrator record: inspect `/tmp/zapbot-ao.log`
- orchestrator exists but no workers: inspect the orchestrator session and
  `/tmp/zapbot-bridge.log`
- `Mode: local-only` in the startup receipt: your gateway/public URL demo env
  did not activate

6. A simple communication sketch:

```text
orchestrator -> worker #1: inspect src/ and report the risky path
orchestrator -> worker #2: inspect test/ and report missing coverage
worker #1 -> orchestrator: findings for src/
worker #2 -> orchestrator: findings for test/
orchestrator -> GitHub: consolidated summary
```

7. Clean shutdown:

- Stop the demo by pressing `Ctrl+C` in the `start.sh` shell that launched it.
- `Ctrl+C` stops the bridge and AO parent processes from that shell. It is not
  a global garbage-collect command for every managed session record.
- If you inspect any leftovers manually, compare them against
  the managed-session registry first.
- If a registry record remains after shutdown, check whether it still appears in
  `ao status --json` before you touch it. A stale record is not the same thing
  as a live session.
- Do not kill a tmux session because the name "looks like zapbot"; only
  sessions explicitly recorded as managed are in scope.
- Deterministic manual teardown for live managed sessions:

```bash
jq -r '.records[] | .tag.sessionName' "$REGISTRY" |
  while read -r session_id; do
    ao session kill "$session_id" || true
  done
```

- When you are done with the throwaway demo, delete the repo you created:

```bash
gh repo delete "$DEMO_REPO" --yes
```

Repo deletion cleans up the throwaway GitHub artifacts. It does not revoke or
rotate any reusable token, App, gateway, or MoltZap secret you chose for the
demo.

## Add another repo later

From the additional project checkout:

```bash
cd /path/to/other-project
/path/to/zapbot/bin/zapbot-team-init --add-repo owner/other-repo
```

## GitHub App setup

Minimum GitHub App config:

- Webhook URL: `https://<bridge-or-gateway>/api/webhooks/github`
- Webhook secret: the same value as `ZAPBOT_WEBHOOK_SECRET`
- Event: `Issue comment`

Permissions:

- Issues read/write: zapbot reacts to comments and posts status/feedback
- Pull requests read/write and Contents read/write: spawned AO workers use the
  installation token to edit branches and open PRs
- Checks read: worker automation reads repo check state

## Development

From the zapbot checkout:

```bash
bun run test
bun run lint
bun run build
```

Useful entrypoints:

- `bun run bridge` - run only the webhook bridge; expects canonical local
  config or hosted env to already be present
- `./start.sh .` - run the bridge and AO together from a project checkout

## Repo map

- `src/` - current runtime: webhook intake, canonical config service, GitHub helpers,
  orchestrator forwarding, MoltZap session support
- `worker/` - repo-local AO plugin and Claude/MoltZap worker launcher
- `gateway/` - optional bridge registry / webhook proxy
- `bin/webhook-bridge.ts` - bridge entrypoint
- `bin/ao-spawn-with-moltzap.ts` - worker spawn helper that preserves the
  MoltZap control link

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current module layout.
