# Changelog

## 0.4.0 (2026-04-14)

Teammates can now install zapbot in 30 seconds without touching server infrastructure. The skill and orchestrator are cleanly separated.

### Added

- **Skill/orchestrator split** — `./setup` installs only what teammates need (skill + plannotator). `./setup --server` adds ngrok and agent-orchestrator for eng leads.
- **`/zapbot` meta-skill** — single entry point with onboarding wizard. First run asks for bridge URL and secret, writes `~/.zapbot/config.json`, validates bridge reachability.
- **`/zapbot-status` skill** — check workflow status for any issue from Claude Code.
- **Dry-run mode** — first publish shows a preview before executing. Also available via `--dry-run`.
- **Auto-upgrade check** — preamble checks for new versions every 24h.
- **Structured JSON errors** — all bridge API endpoints return `{error: {type, message, status}}`.
- **Team-init config snippet** — outputs a ready-to-paste config for teammates.
- **Per-user bridge config** — `~/.zapbot/config.json` maps repos to bridge URLs and secrets.

### Changed

- **zapbot-publish rewritten** — Claude orchestrates each step directly. No more silent bash failures.
- **README split** — "For Teammates" and "For Eng Leads" sections.

### Fixed

- Workflow ID consistency (repo-scoped IDs in triage agent)
- CORS preflight handler (OPTIONS before POST route check)
- GraphQL injection (variable binding in convertPrToDraft)
- Callback token auth (required, issue-scoped)
- JSON injection in start.sh (jq for safe construction)
- Webhook dedup on early-return paths

### Tests

- 61 → 136 tests: state machine, webhook mapper, agent completions, error responses, HMAC verification, bridge endpoints, heartbeat, store queries.

## 0.3.0 (2026-04-13)

Multi-repo support. Run one bridge instance across multiple GitHub repos.

### What changed

- **Multi-repo webhook routing** — Bridge loads `agent-orchestrator.yaml` via a new config loader (`src/config/loader.ts`), routes webhooks by `repository.full_name`, and rejects unconfigured repos with 403.
- **Per-repo webhook secrets** — Each project can specify its own `secretEnvVar` in the config. HMAC verification resolves the per-repo secret first, falls back to shared `ZAPBOT_API_KEY`.
- **Repo-scoped plannotator tokens** — Callback tokens now carry repo context. The bridge stores them locally with a 24-hour TTL instead of proxying to AO. Resolves repo via: token store → request body → `ZAPBOT_REPO` env var.
- **Project-scoped `ao spawn`** — The spawner passes `--project <name>` so AO routes to the correct project.
- **Webhook cleanup on shutdown** — `start.sh` tracks webhook IDs and deactivates them when you Ctrl+C, preventing stale webhook deliveries.
- **Multi-repo webhook registration** — `start.sh` registers webhooks on all repos from the config via a single ngrok tunnel.

### For contributors

- New `src/config/loader.ts` module with full test coverage (`test/config-loader.test.ts`)
- `SpawnContext` now includes optional `projectName`
- 57 unit tests across 3 files (state-machine, store, config-loader)

## 0.2.0 (2026-04-12)

Fixes all path assumptions from the global install restructuring.

### What changed

- **start.sh now runs from the project directory** — pass a project path or run from the project dir. No more hardcoded `zapbot-test` fallback.
- **`.env` sourced before defaults** — port and label settings from `.env` actually work now.
- **team-init generates `.env`** — random webhook secret, correct repo name, mode 600.
- **Share links work from any repo** — `zapbot-publish.sh` finds `share-link.ts` via `ZAPBOT_DIR`, not the project's git root.
- **Bridge URL persisted in `.env`** — `start.sh` writes the ngrok URL to the project's `.env` so the publish script can find it in a separate Claude Code session.
- **Re-approve after plan update works** — `spawnedIssues` in the bridge has a 1-hour TTL, not permanent.
- **`--no-ngrok` flag** — for GCP or static IP deployments.
- **`jq` added to prerequisites**
- **Hardcoded configs removed** — `agent-orchestrator.yaml` and `.agent-rules.md` are generated per-repo by `team-init`, not committed in the zapbot tool repo.

### For contributors

- Codex adversarial review found 14 post-restructuring gaps. All fixed.
- `ZAPBOT_DIR` env var available in all scripts for locating zapbot binaries.

## 0.1.0 (2026-04-12)

Initial release. Plan-to-code workflow for teams.

### What you can do

- Create plans in Claude Code and publish them as GitHub issues with `/zapbot-publish`
- Share plans for visual review via plannotator (E2E encrypted share links)
- Add `plan-approved` label to trigger automatic implementation by a Claude Code agent
- Agent creates a PR in an isolated git worktree, with CI auto-fix via agent-orchestrator
- One-command setup (`./setup`) and startup (`./start.sh`)

### Components shipped

- **webhook-bridge** (bin/webhook-bridge.ts) — Bun HTTP server that receives GitHub webhooks, triggers `ao spawn` on label events, handles plannotator annotation callbacks, and proxies to agent-orchestrator
- **zapbot-publish** (bin/zapbot-publish.sh) — publishes plans as GitHub issues with plannotator share links, handles issue create/update, label invalidation on plan changes
- **share-link** (bin/share-link.ts) — generates plannotator share URLs with optional callback params for annotation sync
- **Claude Code skill** (.claude/skills/zapbot-publish/SKILL.md) — thin wrapper that calls zapbot-publish.sh

### Security

- HMAC-SHA256 webhook signature verification (no hardcoded secrets)
- Token registration endpoint requires Bearer auth
- Callback tokens are one-time-use, stored server-side (not in issue body)
- `.env` created with mode 600

### For contributors

- E2E smoke test suite (14 tests): `./test/e2e-smoke.sh`
- `setup` script only installs tools and configures the GitHub repo (no file generation)
- Config files are tracked in git, not generated by scripts
