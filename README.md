# Zapbot

Zapbot is a thin GitHub webhook control bridge that dispatches `@zapbot ...`
mentions into a persistent zapbot orchestrator process.

GitHub keeps the durable task record. Zapbot verifies webhooks, checks repo
permissions, and POSTs `/turn` requests into the orchestrator, which resumes
the project's lead Claude Code session and dispatches workers via the
`@moltzap/runtimes` ClaudeCodeAdapter.

## Plain-language terms

- The zapbot orchestrator is a long-lived HTTP process that owns one Claude
  Code lead session per configured project (resumed via `claude -p --resume`).
- Worker sessions are short-lived Claude Code processes spawned by the lead
  session through the `request_worker_spawn` MCP tool, dispatched by
  `@moltzap/runtimes`.
- MoltZap is the live messaging layer; the lead and worker sessions coordinate
  in real time over MoltZap channels backed by the moltzap-server.

## Runtime flow

1. GitHub sends `issue_comment` webhooks to `/api/webhooks/github`.
2. Zapbot verifies the HMAC and parses a literal `@zapbot ...` command.
3. Zapbot checks that the commenter has write access.
4. The bridge POSTs `/turn` to the persistent zapbot orchestrator process.
5. The orchestrator resumes the project's lead Claude Code session inside
   `~/.zapbot/projects/<slug>/checkout/`.
6. The lead session calls the `request_worker_spawn` MCP tool to dispatch
   ephemeral workers via `@moltzap/runtimes` ClaudeCodeAdapter.

## Canonical commands

### `setup --server`

Run this from the zapbot checkout on the bridge host:

```bash
./setup --server
```

This installs zapbot's repo dependencies and verifies the server-side
prerequisites (claude CLI, tmux, jq, node) used by the orchestrator and
moltzap-server. If Bun is missing, setup installs it too.

### `zapbot-team-init`

Use this from the project checkout zapbot should operate on:

```bash
/path/to/zapbot/bin/zapbot-team-init owner/repo
```

That registers the project in `~/.zapbot/projects.json` (the orchestrator's
project loader source) and mints the shared secrets in `~/.zapbot/config.json`.
The bridge separately reads `agent-orchestrator.yaml` from the project
directory for its repo-routing table; create or maintain that file alongside
the project's `.env` when running the bridge. To add another repo later, use:

```bash
/path/to/zapbot/bin/zapbot-team-init --add-repo owner/other-repo
```

### `start.sh .`

Run this from the project checkout after `zapbot-team-init` has created the
local config:

```bash
/path/to/zapbot/start.sh .
```

`start.sh` sources the project's `.env` for non-secret operator settings,
loads shared secrets from `~/.zapbot/config.json`, and (when running the
bridge) expects `ZAPBOT_CONFIG` to point at the project's
`agent-orchestrator.yaml` so the bridge can route webhooks. It launches the
moltzap-server, the zapbot orchestrator (which reads
`~/.zapbot/projects.json`), and the webhook bridge on `ZAPBOT_PORT` or
`3000`.

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

MoltZap is the channel layer between the Claude Code lead session and any
workers it spawns via `request_worker_spawn`. Zapbot mints fresh per-session
MoltZap credentials at boot (for the bridge) and at spawn time (for each
worker), so neither component sees a long-lived API key.

Required env (when MoltZap is enabled):

| Env | Meaning |
|---|---|
| `ZAPBOT_MOLTZAP_SERVER_URL` + `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` | register a fresh MoltZap agent for the bridge at every boot, then mint per-worker creds at spawn time (architect rev 4 §4.3) |

If `ZAPBOT_MOLTZAP_SERVER_URL` is unset, zapbot runs without MoltZap and the
lead cannot spawn workers. The static `ZAPBOT_MOLTZAP_API_KEY` mode was
removed in sbd#199 — `loadMoltzapRuntimeConfig` now requires a registration
secret whenever a server URL is set.

Worker env posture:

- Zapbot forwards the GitHub installation token (`GH_TOKEN`) into the
  orchestrator's spawned Claude lead and worker sessions so they can use
  GitHub on behalf of the repo. That token stays inside the local trust
  boundary on the operator machine. It is not meant to cross into GitHub,
  MoltZap messages, or published artifacts.
- Zapbot forwards `MOLTZAP_*` only when MoltZap is configured.
- Zapbot does **not** forward `ZAPBOT_API_KEY`, `ZAPBOT_WEBHOOK_SECRET`,
  `ZAPBOT_ORCHESTRATOR_SECRET`, or `GITHUB_APP_PRIVATE_KEY` into the
  spawned child processes.

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

2. Change into the project checkout zapbot should operate on, then
   register the project with zapbot:

```bash
cd /path/to/your-project
/path/to/zapbot/bin/zapbot-team-init owner/repo
```

This writes the project entry into `~/.zapbot/projects.json` (the
orchestrator's project loader source) and mints shared secrets in
`~/.zapbot/config.json`. The bridge reads `agent-orchestrator.yaml` from
the project directory for repo routing; create that file plus a project
`.env` alongside it (a generated `.env` may already be present from older
zapbot versions; the values it contained — webhook secret, api key — are
now centralised in `~/.zapbot/config.json`).

3. Edit the generated `.env` and add GitHub auth plus any optional gateway or
   MoltZap config you need:

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

# Optional: MoltZap (registration secret is required when SERVER_URL is set)
# ZAPBOT_MOLTZAP_SERVER_URL=wss://moltzap.example
# ZAPBOT_MOLTZAP_REGISTRATION_SECRET=...
```

Set `ZAPBOT_CONFIG` (typically in the project `.env`) to the absolute or
relative path of `agent-orchestrator.yaml` so the bridge process can load
its repo-routing table at boot. `start.sh` sources the project `.env`
before launching the bridge, so exporting `ZAPBOT_CONFIG=./agent-orchestrator.yaml`
in `.env` is sufficient.

4. Start the operator stack from the same project checkout:

```bash
cd /path/to/your-project
/path/to/zapbot/start.sh .
```

## Startup receipt

When startup succeeds, you should see output like this:

```text
=== Starting Zapbot ===
Project: /path/to/your-project
Mode:    local-only

moltzap-server ready on port 3100
Orchestrator ready on port 3002
Bridge ready on port 3000

================================================
  Zapbot is running!
================================================
  Project:       /path/to/your-project
  Mode:          local-only
  Bridge:        http://localhost:3000
  Orchestrator:  http://localhost:3002
  MoltZap:       http://127.0.0.1:3100
  Gateway:       (local-only)
  Public:        (local-only)

  Publish:   bash /path/to/zapbot/bin/zapbot-publish.sh <plan-file>

  Logs: /tmp/zapbot-{moltzap,orchestrator,bridge}.log
  Press Ctrl+C to stop everything.
================================================
```

If `ZAPBOT_GATEWAY_URL` is set, the `Gateway:` and `Public:` lines show the
configured public URLs instead of `(local-only)`. If readiness lines do not
appear, check `/tmp/zapbot-moltzap.log`, `/tmp/zapbot-orchestrator.log`, or
`/tmp/zapbot-bridge.log`.

## Dummy-project demo

This demo assumes you have a reachable MoltZap server and have set
`ZAPBOT_MOLTZAP_SERVER_URL` + `ZAPBOT_MOLTZAP_REGISTRATION_SECRET`.

1. Create a dummy project checkout, initialize zapbot, and start the stack:

```bash
mkdir -p /tmp/zapbot-demo
cd /tmp/zapbot-demo
git init -b main
gh repo create owner/zapbot-demo --private
/path/to/zapbot/bin/zapbot-team-init owner/zapbot-demo
/path/to/zapbot/start.sh .
```

2. Open two issues in that repo, then comment on each one:

```bash
ISSUE_A_URL="$(gh issue create --repo owner/zapbot-demo --title 'agent A' --body 'dummy')"
ISSUE_B_URL="$(gh issue create --repo owner/zapbot-demo --title 'agent B' --body 'dummy')"
ISSUE_A="${ISSUE_A_URL##*/issues/}"
ISSUE_B="${ISSUE_B_URL##*/issues/}"
gh issue comment "$ISSUE_A" --repo owner/zapbot-demo --body '@zapbot plan this'
gh issue comment "$ISSUE_B" --repo owner/zapbot-demo --body '@zapbot investigate this'
```

3. What you should see:

- the bridge accepting both webhook deliveries and dispatching them to the
  orchestrator's `/turn` endpoint
- one persistent Claude Code lead session per project, resumed across turns
  (`~/.zapbot/projects/<slug>/session.json` carries `currentSessionId`)
- the lead invoking the `request_worker_spawn` MCP tool when a comment asks
  for follow-up work; each spawn boots a `@moltzap/runtimes`
  `ClaudeCodeAdapter` worker linked back to the lead over MoltZap
- workers committing/pushing branches and posting their output to GitHub via
  the forwarded installation token

4. A simple communication sketch:

```text
github webhook  -> bridge   -> orchestrator /turn -> claude lead (resumed)
claude lead     -> request_worker_spawn (MCP)     -> @moltzap/runtimes worker
worker          -> MoltZap channel                -> claude lead
claude lead     -> gh issue/pr api                -> GitHub
```

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
- Pull requests read/write and Contents read/write: spawned worker sessions
  use the installation token to edit branches and open PRs
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
- `./start.sh .` - run the moltzap-server, orchestrator, and bridge together
  from a project checkout

## Repo map

- `src/` - current runtime: webhook intake, config load/reload, GitHub
  helpers, orchestrator forwarding, MoltZap session support, and the
  `orchestrator/` HTTP server + claude-runner + spawn-broker
- `gateway/` - optional bridge registry / webhook proxy
- `bin/webhook-bridge.ts` - bridge entrypoint
- `bin/zapbot-orchestrator.ts` - orchestrator entrypoint (HTTP `/turn`
  listener + Claude session resumption + spawn broker)
- `bin/zapbot-spawn-mcp.ts` - MCP server backing the
  `request_worker_spawn` tool used by lead Claude sessions

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current module layout.
