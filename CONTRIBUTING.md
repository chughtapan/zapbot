# Contributing

## Local setup

```bash
bun install
```

Bridge operators also need:

- `gh` authenticated
- `ao` installed
- a GitHub App or PAT-based auth configuration

Operator bootstrap flow (`./setup --server` provisions the `bun` + `ao` runtime
used by the later commands):

```bash
cd /path/to/zapbot
./setup --server

cd /path/to/your-project
/path/to/zapbot/bin/zapbot-team-init owner/repo
# zapbot-team-init prints the canonical project key; keep it for validation
# keep gateway/public/MoltZap unset for first success
# edit ~/.zapbot/projects/<project-key>/project.json
/path/to/zapbot/start.sh .
# '.' is the required current project checkout selector here
# validate /healthz plus ao status before any advanced ingress work
```

Config contract:

- Local operator mode stores the canonical project config only at
  `~/.zapbot/projects/<project-key>/project.json`.
- Hosted/platform mode reads `ZAPBOT_*` plus GitHub auth env from the process
  environment, typically injected from GitHub repository or environment
  secrets, including required `ZAPBOT_CHECKOUT_PATH`.
- Hosted/platform mode is deployment-owned and prerequisite-heavy; README keeps
  `local-only` as the only self-contained first-success path.
- README owns the local-only first-success path plus the advanced/reference
  notes for hosted and public ingress.
- Checkout-local `.env` and `agent-orchestrator.yaml` are legacy artifacts and
  should not be recreated.
- GitHub comment bodies remain untrusted input even after signature and repo
  permission checks.
- Repo write access gates invocation of the `@zapbot` path; it does not make
  comment content trusted.
- Once zapbot forwards `GH_TOKEN` into an AO child session, behavior inside
  that session is outside the bridge's enforcement boundary.
- Use least-privilege GitHub auth for that forwarded `GH_TOKEN` path.

## Advanced operator reference

README is intentionally limited to the self-contained `local-only` quickstart.
Use this section for the non-quickstart operator contract.

Hosted/platform mode:

- is deployment-owned, not a README bootstrap path
- requires the deployment to provide the `./setup --server` equivalent before
  startup, including the `bun` + `ao` runtime
- reads `ZAPBOT_*` plus GitHub auth env from the process environment
- requires `ZAPBOT_CHECKOUT_PATH` so zapbot can resolve the repo/worktree root

Hosted env is the env-shaped version of the same local config contract:

| Local `project.json` field | Hosted env | Notes |
|---|---|---|
| `checkoutPath` | `ZAPBOT_CHECKOUT_PATH` | required absolute checkout path on the host |
| `projectKey` | `ZAPBOT_PROJECT_KEY` | optional hosted override |
| `bridge.port` | `ZAPBOT_PORT` | bridge HTTP port |
| `bridge.aoPort` | `ZAPBOT_AO_PORT` | AO runtime/dashboard port |
| `bridge.publicUrl` | `ZAPBOT_BRIDGE_URL` | public bridge URL |
| `bridge.gatewayUrl` | `ZAPBOT_GATEWAY_URL` | GitHub-facing ingress URL |
| `bridge.gatewaySecret` | `ZAPBOT_GATEWAY_SECRET` | optional gateway auth secret |
| `bridge.apiKey` | `ZAPBOT_API_KEY` | bridge bearer for internal callers |
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

Public ingress (`github-demo`):

- is an advanced path, not a first-success path
- assumes you already have a reachable gateway/public URL pair and GitHub
  webhook registration access
- uses `bridge.gatewayUrl` / `ZAPBOT_GATEWAY_URL` as the GitHub-facing webhook
  target and `bridge.publicUrl` / `ZAPBOT_BRIDGE_URL` as the bridge URL behind
  that ingress
- uses `routes[].webhookSecret` locally or `ZAPBOT_WEBHOOK_SECRET` in hosted
  mode

MoltZap:

- is optional for README first success
- becomes relevant only when you already have MoltZap infrastructure and want
  live worker coordination

## Core commands

```bash
bun run test
bun run lint
bun run build
bun run bridge
```

## Current repo layout

```text
bin/
  webhook-bridge.ts        bridge entrypoint
  zapbot-team-init         repo onboarding helper
  ao-spawn-with-moltzap.ts worker spawn helper

src/
  bridge.ts                webhook handling + orchestrator forwarding
  config/                  canonical Effect-native config service
  github/                  GitHub auth/API wrapper
  http/                    HMAC verification and JSON error helpers
  orchestrator/            persistent AO orchestrator control path
  moltzap/                 MoltZap runtime/session support

worker/
  ao-plugin-agent-claude-moltzap/
                           checked-in Claude/MoltZap AO agent plugin

gateway/
  optional webhook proxy / bridge registry

test/
  unit and property tests for the current runtime
```

## What not to reintroduce

Do not add back:

- SQLite-backed workflow state
- internal agent team abstractions on top of `ao`
- workflow/history HTTP APIs that are no longer part of the shipped surface
- docs that describe deleted state-machine behavior as current

## Updating the bridge

1. Make the runtime change in `src/` or `worker/`, whichever owns the live path.
2. Add or update tests under `test/`.
3. Run `bun run test`, `bun run lint`, and `bun run build`.
4. Keep README, ARCHITECTURE, and onboarding scripts aligned with the shipped path.
