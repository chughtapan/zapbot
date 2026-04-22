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
2. Zapbot verifies the HMAC and parses a literal `@zapbot ...` command.
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

That creates `agent-orchestrator.yaml` and `.env` in the current project
directory. To add another repo later, use:

```bash
/path/to/zapbot/bin/zapbot-team-init --add-repo owner/other-repo
```

### Start the stack with `start.sh .`

Run this from the project checkout after `zapbot-team-init` has created the
local config:

```bash
/path/to/zapbot/start.sh .
```

`start.sh` expects `agent-orchestrator.yaml` and `.env` in the project
directory. It starts AO on `ZAPBOT_AO_PORT` or `3001`, then the webhook bridge
on `ZAPBOT_PORT` or `3000`.

The README examples use `start.sh` in a foreground shell so you can see the
readiness receipt and stop local or demo startup with `Ctrl+C`. For always-on
deployment, keep the same project-local config but run zapbot under your normal
process supervisor or service manager.

`start.sh` treats ingress as an explicit mode:

- `local-only` runs the stack without public GitHub ingress.
- `github-demo` requires a reachable public bridge URL and fails closed if the
  bridge URL is missing or unreachable.

If `ZAPBOT_GATEWAY_URL` is unset or only whitespace, `start.sh` stays
`local-only`. In demo mode, set `ZAPBOT_GATEWAY_URL` and `ZAPBOT_BRIDGE_URL`
before startup.

### Supported GitHub comment commands

Zapbot only reacts to comments that start with the literal `@zapbot` prefix.

| Comment | Meaning |
|---|---|
| `@zapbot plan this` | ask the orchestrator to plan work for the issue |
| `@zapbot triage this` | alias for `plan this` |
| `@zapbot investigate this` | ask the orchestrator to investigate the issue |
| `@zapbot investigate` | alias for `investigate this` |
| `@zapbot status` | post a GitHub-native issue summary |

Zapbot does not splice raw comment text into a shell command.

## MoltZap

Zapbot can provision MoltZap credentials for orchestrator and worker sessions.

Supported modes:

| Env | Meaning |
|---|---|
| `ZAPBOT_MOLTZAP_SERVER_URL` + `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` | register a fresh MoltZap agent for each spawned worker; this takes precedence over a static API key if both are set |
| `ZAPBOT_MOLTZAP_SERVER_URL` + `ZAPBOT_MOLTZAP_API_KEY` | pass through a pre-provisioned MoltZap agent key to the runtime |
| `ZAPBOT_MOLTZAP_ALLOWED_SENDERS` | optional comma-separated sender allowlist forwarded to the session runtime |

If `ZAPBOT_MOLTZAP_SERVER_URL` is unset, zapbot runs without MoltZap.

Worker env posture:

- If operators set `ZAPBOT_GITHUB_TOKEN` in `.env`, zapbot forwards that value
  into AO child sessions as `GH_TOKEN`.
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
   local zapbot config for that repo:

```bash
cd /path/to/your-project
/path/to/zapbot/bin/zapbot-team-init owner/repo
```

This creates these files in the current project directory:

- `agent-orchestrator.yaml` - repo routing + AO project config
- `.env` - generated webhook secret and local broker bearer, plus commented
  placeholders for the remaining operator-managed settings

Treat the generated `.env` as secret material: it contains secrets and bearer
values. Keep it local to the operator machine, do not commit it, and restrict
file permissions to the operator account, for example with `chmod 600 .env`.

3. Edit the generated `.env` locally and add GitHub auth plus any optional
   gateway or MoltZap config you need:

```bash
# Generated by zapbot-team-init
ZAPBOT_WEBHOOK_SECRET=...
ZAPBOT_API_KEY=...

# Required: pick one GitHub auth mode
ZAPBOT_GITHUB_TOKEN=...
# or:
GITHUB_APP_ID=...
GITHUB_APP_INSTALLATION_ID=...
GITHUB_APP_PRIVATE_KEY=/path/to/app.pem

# Optional: public gateway registration
# ZAPBOT_GATEWAY_URL=https://gateway.example.com
# ZAPBOT_GATEWAY_SECRET=...
# ZAPBOT_BRIDGE_URL=https://bridge.example.com

# Optional: MoltZap
# ZAPBOT_MOLTZAP_SERVER_URL=wss://moltzap.example/ws
# ZAPBOT_MOLTZAP_API_KEY=...
# ZAPBOT_MOLTZAP_REGISTRATION_SECRET=...
# ZAPBOT_MOLTZAP_ALLOWED_SENDERS=agent-a,agent-b
```

If you use the token auth path, set `ZAPBOT_GITHUB_TOKEN` in `.env`; zapbot
forwards that value into AO child sessions as `GH_TOKEN`.

`start.sh` automatically points `ZAPBOT_CONFIG` at `./agent-orchestrator.yaml`,
so normal startup does not require setting that variable by hand.

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

Lifecycle ownership is explicit and project-local. Zapbot writes a registry
file named `.zapbot-managed-sessions.json` beside `agent-orchestrator.yaml`,
and only the sessions recorded there are eligible for automation.

Terms used in this section:

- A session is a live AO runtime session.
- A registry record is one JSON row in `.zapbot-managed-sessions.json`.
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
  `.zapbot-managed-sessions.json`, zapbot must not stop or garbage-collect it.
- Only GitHub users with write access to the repo can drive the `@zapbot ...`
  control path. Random issue commenters are not part of the control boundary.
- Bridge secrets such as `ZAPBOT_API_KEY`, `ZAPBOT_WEBHOOK_SECRET`, and
  `GITHUB_APP_PRIVATE_KEY` stay on the bridge host and are not forwarded into
  AO child sessions.

### Lifecycle inspection entrypoints

Supported lifecycle inspection and teardown entrypoints today are the
project-local registry queried with `jq` and AO's own `ao status --json`
output. Start with those views before any manual attach or teardown; there is
no separate zapbot lifecycle CLI in this README.

From the project checkout:

```bash
jq '.records[] | {session: .tag.sessionName, scope: .tag.scope, phase: .phase, tmux: .tmuxName, worktree: .worktree}' \
  .zapbot-managed-sessions.json

ao status --json | jq '.[] | {name, role, status}'
```

Safe manual cleanup rule:

- Start from `.zapbot-managed-sessions.json`, not from guessed tmux names.
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

2. Before `start.sh .`, make sure the generated `.env` is ready for the
runtime:

- The generated `.env` contains live secrets and bearer values. Keep it local
  to the operator machine, do not commit it, and restrict it to the operator
  account.

- Choose exactly one GitHub auth path for the demo:
  - Personal/token path:

    ```bash
    ZAPBOT_GITHUB_TOKEN=ghp_or_github_pat_with_repo_access
    ```

  - GitHub App path:

    ```bash
    GITHUB_APP_ID=123456
    GITHUB_APP_INSTALLATION_ID=78901234
    GITHUB_APP_PRIVATE_KEY=/absolute/path/to/demo-app.pem
    ```

- `gh auth status` should show you are logged in, because the demo creates the
  repo and issues with the GitHub CLI.
- `ZAPBOT_WEBHOOK_SECRET` is already generated by `zapbot-team-init`.
- If `ZAPBOT_GATEWAY_URL` trims to empty, `start.sh` stays `local-only` and
  will not run the GitHub-backed demo path.
- If you use `ZAPBOT_GITHUB_TOKEN`, it should be a token that can create the
  throwaway repo and comment on its issues. If you use GitHub App env instead,
  those values come from the App you configured for this demo repo.

Demo env checklist:

| Variable | Required | Example | Where it comes from | Failure shape if wrong |
|---|---|---|---|---|
| `ZAPBOT_GITHUB_TOKEN` | one auth path only | `ghp_...` | GitHub token or PAT with repo access | issue/repo operations fail |
| `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY` | one auth path only | `123456`, `78901234`, `/path/app.pem` | GitHub App configured for the demo repo | installation token broker fails |
| `ZAPBOT_GATEWAY_URL` | yes for `github-demo` | `https://gateway.example.com` | your public gateway/proxy URL | startup stays `local-only` or demo cannot ingress |
| `ZAPBOT_BRIDGE_URL` | yes for `github-demo` | `https://bridge.example.com` | the public URL that reaches this bridge host | startup exits `missing` or `unreachable` |
| `ZAPBOT_MOLTZAP_SERVER_URL` | yes for this demo | `wss://moltzap.example/ws` | your MoltZap server | workers come up without live MoltZap coordination |
| `ZAPBOT_MOLTZAP_API_KEY` or `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` | yes for this demo | `mz_...` or shared registration secret | your MoltZap deployment | worker provisioning fails |

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
gh issue comment "$ISSUE_A" --repo "$DEMO_REPO" --body '@zapbot plan this'
gh issue comment "$ISSUE_B" --repo "$DEMO_REPO" --body '@zapbot investigate this'
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
jq '.records[] | {session: .tag.sessionName, scope: .tag.scope, phase: .phase, tmux: .tmuxName}' \
  .zapbot-managed-sessions.json

ORCH_TMUX="$(jq -r '.records[] | select(.tag.scope=="orchestrator") | .tmuxName' .zapbot-managed-sessions.json)"
tmux attach -t "$ORCH_TMUX"
```

You should see exactly one orchestrator record and two worker records in the
managed-session registry. If you want to inspect the workers too, use the
registry values instead of guessing session names:

```bash
jq -r '.records[] | select(.tag.scope=="worker") | .tmuxName' \
  .zapbot-managed-sessions.json
```

If `tmuxName` is missing for a record, do not guess. Treat that as a signal to
inspect `ao status --json` and `/tmp/zapbot-ao.log` instead of attaching by
hand.

Single-command questions to ask during the demo:

| Question | Command |
|---|---|
| Is the public bridge up? | `curl -fsS "${ZAPBOT_BRIDGE_URL%/}/healthz"` |
| Which sessions does zapbot think it owns? | `jq '.records[] | {session: .tag.sessionName, scope: .tag.scope, phase: .phase}' .zapbot-managed-sessions.json` |
| Which AO sessions are actually live? | `ao status --json | jq '.[] | {name, role, status}'` |
| Which tmux session should I attach to? | `jq -r '.records[] | select(.tag.scope=="orchestrator") | .tmuxName' .zapbot-managed-sessions.json` |

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
  `.zapbot-managed-sessions.json` first.
- If a registry record remains after shutdown, check whether it still appears in
  `ao status --json` before you touch it. A stale record is not the same thing
  as a live session.
- Do not kill a tmux session because the name "looks like zapbot"; only
  sessions explicitly recorded as managed are in scope.
- Deterministic manual teardown for live managed sessions:

```bash
jq -r '.records[] | .tag.sessionName' .zapbot-managed-sessions.json |
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

- `bun run bridge` - run only the webhook bridge; expects config/env to already
  be present
- `./start.sh .` - run the bridge and AO together from a project checkout

## Repo map

- `src/` - current runtime: webhook intake, config load/reload, GitHub helpers,
  orchestrator forwarding, MoltZap session support
- `worker/` - repo-local AO plugin and Claude/MoltZap worker launcher
- `gateway/` - optional bridge registry / webhook proxy
- `bin/webhook-bridge.ts` - bridge entrypoint
- `bin/ao-spawn-with-moltzap.ts` - worker spawn helper that preserves the
  MoltZap control link

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current module layout.
