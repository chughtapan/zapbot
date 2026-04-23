# Zapbot

Zapbot is a thin GitHub webhook control bridge for the AO runtime (`ao`).

GitHub keeps the durable task record. Zapbot validates GitHub webhook
signatures against the configured secret, checks repo permissions, and forwards
control events into a persistent AO orchestrator session for each configured
project.

## Plain-language terms

- `ao` is the CLI/runtime zapbot uses to start and keep agent sessions alive.
- An orchestrator session is the always-on AO session for one project. It reads
  GitHub events, chooses what to do next, and delegates work.
- Worker sessions are short-lived AO sessions spawned for one issue or task.
- MoltZap is the live messaging layer attached to an AO session. Zapbot uses
  it so the orchestrator and workers can coordinate in real time.

## Runtime flow

1. GitHub sends `issue_comment` webhooks to `/api/webhooks/github`.
2. Zapbot validates the configured GitHub webhook signature and detects an
   eligible direct `@zapbot` mention.
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

- the `Initialized <project-key> under ...` value printed by the first
  `zapbot-team-init` run, or
- `jq -r '.projectKey + " -> " + .checkoutPath' "$HOME"/.zapbot/projects/*/project.json`
  to rediscover existing project keys and their primary checkouts

```bash
/path/to/zapbot/bin/zapbot-team-init --project-key <project-key> --add-repo owner/other-repo
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

In this README, every `start.sh .` example assumes you already `cd`'d into the
target project checkout first. The `.` is the checkout path zapbot resolves.
`/path/to/zapbot/start.sh /path/to/your-project` is the same launch with an
explicit checkout path.

Legacy checkout-local config artifacts are unsupported. If the project checkout
still contains `.env` or `agent-orchestrator.yaml` from an older setup,
zapbot fails closed until those files are removed.

The README examples use `start.sh` in a foreground shell so you can see the
readiness receipt and stop local or advanced public-ingress startup with
`Ctrl+C`. For always-on deployment, keep the same `~/.zapbot` config and run
zapbot under your normal process supervisor or service manager.

`start.sh` treats ingress as an explicit mode:

- `local-only` is the self-contained first-success path. It runs the stack
  without public GitHub ingress.
- `github-demo` is the advanced public-ingress path. It assumes you already
  have a reachable gateway/public URL pair and fails closed if that ingress is
  missing or unreachable.

If `ZAPBOT_GATEWAY_URL` is unset or only whitespace, `start.sh` stays
`local-only`. In the advanced public-ingress path, set `ZAPBOT_GATEWAY_URL`
and `ZAPBOT_BRIDGE_URL` before startup.

Hosted/platform deployments use a different config boundary: set `ZAPBOT_*`
plus GitHub auth env in the deployment environment, typically sourced from
GitHub repository or environment secrets. Do not create repo-local config
files in the checkout for hosted deployments.

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
  the repo.
- The bridge contract ends at that handoff. Zapbot itself does not put
  `GH_TOKEN` into MoltZap env, bridge webhook responses, or bridge-authored
  GitHub artifacts, but once `GH_TOKEN` is available inside an AO child
  session, downstream tools and prompts in that session are outside the
  bridge's enforcement boundary. Scope the token or App installation
  accordingly.
- Treat forwarded `GH_TOKEN` as a high-value ambient credential inside the AO
  child session. Use the narrowest PAT scopes or the smallest-installation
  GitHub App you can; zapbot does not sandbox downstream session behavior.
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
   plus any optional gateway or MoltZap config you need. Relevant fields look
   like this:

```json
{
  "projectKey": "your-project-key",
  "checkoutPath": "/path/to/your-project",
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
  },
  "routes": [
    {
      "repo": "owner/repo",
      "checkoutPath": "/path/to/your-project",
      "defaultBranch": "main",
      "webhookSecret": "generated-by-team-init"
    }
  ]
}
```

Switch `github.mode` to `app` if you want GitHub App auth instead of token
auth:

```json
{
  "github": {
    "mode": "app",
    "appId": "123456",
    "installationId": "78901234",
    "privateKeyPem": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"
  }
}
```

GitHub App fields:

- `appId`: the numeric App ID from the GitHub App settings page
- `installationId`: the installation ID for that App on the target owner/repo
- `privateKeyPem`: the full PEM private-key contents, including the `BEGIN` /
  `END` lines and escaped newlines when stored in JSON

### Local vs hosted config boundary

Use exactly one config surface per deployment:

- Local operator mode: edit `~/.zapbot/projects/<project-key>/project.json`
- Hosted/platform mode: inject env into the process, typically from GitHub
  repository or environment secrets

Hosted env is the env-shaped version of the same config contract:

| Local `project.json` field | Hosted env | Notes |
|---|---|---|
| `bridge.port` | `ZAPBOT_PORT` | bridge HTTP port |
| `bridge.aoPort` | `ZAPBOT_AO_PORT` | AO dashboard/runtime port |
| `bridge.publicUrl` | `ZAPBOT_BRIDGE_URL` | public bridge URL the gateway forwards to in advanced `github-demo` mode |
| `bridge.gatewayUrl` | `ZAPBOT_GATEWAY_URL` | GitHub-facing ingress URL in advanced `github-demo` mode |
| `bridge.gatewaySecret` | `ZAPBOT_GATEWAY_SECRET` | optional gateway auth secret |
| `bridge.apiKey` | `ZAPBOT_API_KEY` | bridge bearer for internal callers |
| `bridge.botUsername` | `ZAPBOT_BOT_USERNAME` | defaults to `zapbot[bot]` |
| `bridge.logLevel` | `ZAPBOT_LOG_LEVEL` | defaults to `info` |
| `routes[].repo` | `ZAPBOT_REPO` | hosted mode is one repo route per process |
| `routes[].defaultBranch` | `ZAPBOT_DEFAULT_BRANCH` | defaults to `main` |
| `routes[].webhookSecret` | `ZAPBOT_WEBHOOK_SECRET` | GitHub webhook HMAC secret |
| `github.token` | `ZAPBOT_GITHUB_TOKEN` | token/PAT auth path |
| `github.appId` | `GITHUB_APP_ID` | GitHub App auth path |
| `github.installationId` | `GITHUB_APP_INSTALLATION_ID` | GitHub App auth path |
| `github.privateKeyPem` | `GITHUB_APP_PRIVATE_KEY` | full PEM contents |
| `moltzap.serverUrl` | `ZAPBOT_MOLTZAP_SERVER_URL` | optional MoltZap runtime |
| `moltzap.registrationSecret` | `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` | optional MoltZap registration |
| `moltzap.allowedSenders` | `ZAPBOT_MOLTZAP_ALLOWED_SENDERS` | optional sender allowlist |

Hosted/platform deployments are different: do not create local project files in
the checkout. Export `ZAPBOT_*` and GitHub auth env from your deployment
environment, typically backed by GitHub repository or environment secrets.

Canonical hosted startup path:

- inject the hosted env from the mapping table above
- start the bridge directly from the zapbot checkout, not via `start.sh`:

```bash
cd /path/to/zapbot
bun run bridge -- --hosted --checkout /path/to/your-project
```

`--checkout` should match the same checkout path you exported as
`ZAPBOT_CHECKOUT_PATH`.

4. Start the operator stack from the same project checkout in a foreground
   shell:

```bash
cd /path/to/your-project
/path/to/zapbot/start.sh .
```

If you want a first-success path without public ingress or MoltZap, stop here
and validate `local-only` mode before step 5:

- leave `bridge.publicUrl`, `bridge.gatewayUrl`, `moltzap.serverUrl`, and
  `moltzap.registrationSecret` as `null`
- confirm the startup receipt shows `Mode: local-only`
- prove the bridge is listening and the managed orchestrator exists:

```bash
cd /path/to/your-project
PROJECT_KEY=your-project-key
CONFIG_PATH="$HOME/.zapbot/projects/$PROJECT_KEY/project.json"
BRIDGE_PORT="$(jq -r '.bridge.port' "$CONFIG_PATH")"
REGISTRY="$HOME/.zapbot/projects/$PROJECT_KEY/state/.zapbot-managed-sessions.json"

curl -fsS "http://127.0.0.1:$BRIDGE_PORT/healthz"
ao status --json | jq '.[] | {name, role, status}'
if [ -f "$REGISTRY" ]; then
  jq '.records[] | {session: .tag.sessionName, scope: .tag.scope, phase: .phase}' "$REGISTRY"
else
  echo "registry missing; inspect /tmp/zapbot-ao.log and ao status --json"
fi
```

That proves canonical local config loading, bridge bring-up, and orchestrator
ownership before you add a gateway, public ingress, or MoltZap.

5. If you intentionally move from `local-only` into the advanced public-ingress
   path, register the repo webhook after the bridge is up and
   `bridge.publicUrl` is reachable.

For canonical local config:

```bash
cd /path/to/your-project
PROJECT_KEY=your-project-key
REPO=owner/repo
CONFIG_PATH="$HOME/.zapbot/projects/$PROJECT_KEY/project.json"
WEBHOOK_SECRET="$(jq -r --arg repo "$REPO" '.routes[] | select(.repo == $repo) | .webhookSecret' "$CONFIG_PATH")"
GITHUB_WEBHOOK_BASE_URL="$(jq -r '.bridge.gatewayUrl // .bridge.publicUrl' "$CONFIG_PATH")"
BRIDGE_PUBLIC_URL="$(jq -r '.bridge.publicUrl' "$CONFIG_PATH")"
printf 'GitHub webhook URL: %s/api/webhooks/github\nBridge public URL: %s\nSecret: %s\n' \
  "${GITHUB_WEBHOOK_BASE_URL%/}" \
  "$BRIDGE_PUBLIC_URL" \
  "$WEBHOOK_SECRET"
```

Register that in the GitHub repo settings:

- Settings -> Webhooks -> Add webhook
- Payload URL: in `github-demo` mode,
  `https://<gateway-url>/api/webhooks/github`; if you intentionally expose the
  bridge directly, `https://<public-bridge>/api/webhooks/github`
- Content type: `application/json`
- Secret: the matching `routes[].webhookSecret` for that repo
- Event: `Issue comment`
- Active: enabled

For hosted/platform mode, use the same webhook URL shape but source the secret
from `ZAPBOT_WEBHOOK_SECRET` instead of `project.json`. In hosted `github-demo`
mode, the GitHub-facing URL is `ZAPBOT_GATEWAY_URL/api/webhooks/github` and the
gateway forwards to `ZAPBOT_BRIDGE_URL`.

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

If you change `~/.zapbot/projects/<project-key>/project.json` while the
service is running, reload or restart the service so zapbot re-reads that
canonical local config. If you change hosted deployment env sourced from
GitHub secrets, update the secrets and restart/redeploy; a process reload
cannot pick up new external env values by itself.

The `Publish:` line is optional. `bin/zapbot-publish.sh [plan-file]` creates or
updates a GitHub issue labeled `zapbot-plan` from a local Markdown plan file.
It is not part of bridge bootstrap, webhook registration, or the `@zapbot`
comment path, so you can ignore it during cold-start operator setup.

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

If the managed-session registry is missing, empty, or stale:

- missing file: treat that as "startup has not produced a usable ledger yet."
  Re-check the startup receipt, `ao status --json`, and `/tmp/zapbot-ao.log`
  before you assume zapbot owns anything.
- empty `records`: do not infer ownership from an empty ledger. Wait for
  orchestrator startup to settle, re-run `ao status --json`, and inspect
  `/tmp/zapbot-ao.log` if it stays empty.
- stale record: if the registry shows a session that `ao status --json` does
  not, treat the record as bookkeeping drift, not proof of a live session. Do
  not kill tmux by name from a stale row alone.

Registry field meanings:

- `tag.sessionName` is the AO session identity.
- `tag.scope` tells you whether the record is for the orchestrator, a worker,
  or another managed surface.
- `phase` is zapbot's lifecycle view of the record, not a promise that the
  session is still live.
- `tmuxName` is the attach target when zapbot knows one.
- `worktree` is the checkout path that session was launched from.

## Advanced `github-demo` walkthrough

This is not the self-contained cold-start path. Use the `local-only`
validation flow above for first success. This advanced walkthrough assumes you
already have a reachable gateway/public ingress pair and a MoltZap server. It
fails closed if that ingress is missing or unreachable. Use a throwaway
private repo for this walkthrough. The final cleanup step deletes that repo,
so do not point this flow at a real project.

1. Create a dummy project checkout, initialize zapbot, and start the stack:

```bash
ZAPBOT_DIR=/absolute/path/to/zapbot
DEMO_OWNER="$(gh api user -q .login)"
DEMO_REPO="$DEMO_OWNER/zapbot-demo"
# This repo is disposable. Step 7 deletes it.
mkdir -p /tmp/zapbot-demo
cd /tmp/zapbot-demo
git init -b main
# On a fresh machine, set git user.name and user.email first if this fails.
git commit --allow-empty -m 'chore: bootstrap demo repo'
gh repo create "$DEMO_REPO" --private --source=. --remote=origin --push
"$ZAPBOT_DIR/bin/zapbot-team-init" "$DEMO_REPO"
```

2. Before `start.sh .`, edit the canonical config file for this throwaway
   project.
   The default project key is the checkout basename, so for `/tmp/zapbot-demo`
   the file is:

```text
$HOME/.zapbot/projects/zapbot-demo/project.json
```

- Choose exactly one GitHub auth path for this walkthrough:
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

- `gh auth status` should show you are logged in, because this walkthrough
  creates the repo and issues with the GitHub CLI.
- `bridge.apiKey` and each route `webhookSecret` are already generated by
  `zapbot-team-init`.
- If `bridge.gatewayUrl` is `null`, `start.sh` stays `local-only` and
  will not run the GitHub-backed advanced path.
- If you use token auth, it should be a token that can create the throwaway
  repo and comment on its issues. If you use GitHub App env instead, those
  values come from the App you configured for this repo.

Advanced-path config checklist inside `project.json`:

| Field | Required | Example | Where it comes from | Failure shape if wrong |
|---|---|---|---|---|
| `github.token` | one auth path only | `ghp_...` | GitHub token or PAT with repo access | issue/repo operations fail |
| `github.appId` / `github.installationId` / `github.privateKeyPem` | one auth path only | `123456`, `78901234`, PEM text | GitHub App configured for the throwaway repo | installation token broker fails |
| `bridge.gatewayUrl` | yes for `github-demo` | `https://gateway.example.com` | your public gateway/proxy URL | startup stays `local-only` or advanced path cannot ingress |
| `bridge.publicUrl` | yes for `github-demo` | `https://bridge.example.com` | the public URL that reaches this bridge host | startup exits `missing` or `unreachable` |
| `moltzap.serverUrl` | yes for this walkthrough | `wss://moltzap.example/ws` | your MoltZap server | workers come up without live MoltZap coordination |
| `moltzap.registrationSecret` | yes for this walkthrough | shared registration secret | your MoltZap deployment | worker provisioning fails |

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

Single-command questions to ask during this walkthrough:

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
- `Mode: local-only` in the startup receipt: your gateway/public URL advanced
  path did not activate

6. A simple communication sketch:

```text
orchestrator -> worker #1: inspect src/ and report the risky path
orchestrator -> worker #2: inspect test/ and report missing coverage
worker #1 -> orchestrator: findings for src/
worker #2 -> orchestrator: findings for test/
orchestrator -> GitHub: consolidated summary
```

7. Clean shutdown:

- Stop this walkthrough by pressing `Ctrl+C` in the `start.sh` shell that
  launched it.
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

- When you are done with the throwaway walkthrough, delete the repo you
  created:

```bash
gh repo delete "$DEMO_REPO" --yes
```

Repo deletion cleans up the throwaway GitHub artifacts. It does not revoke or
rotate any reusable token, App, gateway, or MoltZap secret you chose for this
walkthrough.

## Add another repo later

The `--project-key` to reuse is the same key printed by the first
`zapbot-team-init` run. If you no longer remember it, rediscover the existing
keys and their primary checkouts with:

```bash
jq -r '.projectKey + " -> " + .checkoutPath' "$HOME"/.zapbot/projects/*/project.json
```

From the additional project checkout:

```bash
cd /path/to/other-project
/path/to/zapbot/bin/zapbot-team-init --project-key <existing-project-key> --add-repo owner/other-repo
```

## GitHub App setup

Minimum GitHub App config:

- Webhook URL: in `github-demo` mode,
  `https://<gateway-url>/api/webhooks/github`; if you intentionally expose the
  bridge directly, `https://<public-bridge>/api/webhooks/github`
- Webhook secret: local operator mode uses the matching
  `routes[].webhookSecret` in `~/.zapbot/projects/<project-key>/project.json`;
  hosted/platform mode uses `ZAPBOT_WEBHOOK_SECRET`
- Event: `Issue comment`

GitHub App auth fields:

- `appId`: numeric App ID from the GitHub App settings page
- `installationId`: installation ID for the App installation on the target
  owner/repo
- `privateKeyPem`: full PEM private-key contents, including the `BEGIN` /
  `END` lines

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
  config or hosted env from GitHub secrets to already be present
- `./start.sh /path/to/project-checkout` - run the bridge and AO together for a
  specific project checkout when invoked from the zapbot checkout

## Repo map

- `src/` - current runtime: webhook intake, canonical config service, GitHub helpers,
  orchestrator forwarding, MoltZap session support
- `worker/` - checked-in AO plugin and Claude/MoltZap worker launcher
- `gateway/` - optional bridge registry / webhook proxy
- `bin/webhook-bridge.ts` - bridge entrypoint
- `bin/ao-spawn-with-moltzap.ts` - worker spawn helper that preserves the
  MoltZap control link

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current module layout.
