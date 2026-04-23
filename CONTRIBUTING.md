# Contributing

## Local setup

```bash
bun install
```

Bridge operators also need:

- `gh` authenticated
- `ao` installed
- a GitHub App or PAT-based auth configuration

Operator bootstrap flow:

```bash
cd /path/to/zapbot
./setup --server

cd /path/to/your-project
/path/to/zapbot/bin/zapbot-team-init owner/repo
# zapbot-team-init prints the canonical project key
# edit ~/.zapbot/projects/<project-key>/project.json
/path/to/zapbot/start.sh .
# then register https://<gateway-url>/api/webhooks/github
# in the advanced public-ingress path, or the direct public bridge URL if you expose it
# using the matching routes[].webhookSecret
```

Config contract:

- Local operator mode stores the canonical project config only at
  `~/.zapbot/projects/<project-key>/project.json`.
- Hosted/platform mode reads `ZAPBOT_*` plus GitHub auth env from the process
  environment, typically injected from GitHub repository or environment
  secrets, including required `ZAPBOT_CHECKOUT_PATH`.
- Hosted/platform mode is deployment-owned and prerequisite-heavy; README keeps
  `local-only` as the only self-contained first-success path.
- README owns the local `project.json` <-> hosted env field mapping table and
  the end-to-end webhook setup steps.
- Checkout-local `.env` and `agent-orchestrator.yaml` are legacy artifacts and
  should not be recreated.
- GitHub comment bodies remain untrusted input even after signature and repo
  permission checks.
- Once zapbot forwards `GH_TOKEN` into an AO child session, behavior inside
  that session is outside the bridge's enforcement boundary.
- Use least-privilege GitHub auth for that forwarded `GH_TOKEN` path.

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
