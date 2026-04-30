# Changelog

## Unreleased

Finish the AO removal sweep started in epic #369. The bridge now talks to a
dedicated `zapbot-orchestrator` process that hosts the lead Claude Code session
for each project; AO is no longer in the runtime.

### Added

- **End-to-end webhook integration smoke test** at
  `test/integration/end-to-end-webhook.integration.test.ts`. Boots
  moltzap-server + orchestrator + bridge in-process, sends an HMAC-signed
  `@zapbot plan this` webhook, asserts dispatch body shape + auth + runner-stub
  args + `session.json` persistence + redelivery idempotency.
- **`scripts/prune-vendor-symlinks.sh` postinstall hook** removes broken
  pnpm symlinks under `node_modules/@moltzap/*/node_modules/` after every
  `bun install`. Without this, bun's runtime resolver finds the broken nested
  symlinks first and crashes the orchestrator at boot with `ENOENT reading
  node_modules/@moltzap/runtimes/node_modules/effect`.
- **PAT-mode dispatch support.** `defaultMintToken` now falls back to
  `ZAPBOT_GITHUB_TOKEN` when GitHub App env vars aren't set, mirroring the
  App-then-PAT priority of `createGitHubClient`. Fixes "Installation token
  mint failed" 502 on dispatch when the operator runs in PAT mode.

### Changed

- **`start.sh` boots `moltzap-server` → `zapbot-orchestrator` → `bridge`** with
  a `/health(z)` readiness gate between each phase. The AO startup loop, the
  embedded Node script that mutated `agent-orchestrator.yaml`, the AO log file
  paths, the AO env exports, and the dashboard-port parsing are all gone.
  start.sh now reads secrets exclusively from `~/.zapbot/config.json`.
- **`start.sh` mints MoltZap secrets + writes `~/.zapbot/moltzap.yaml`** on
  first run if absent, then launches `moltzap-server` from a subshell that
  cd's to `~/.zapbot/` so the bin finds `moltzap.yaml` in cwd. start.sh
  exports both `MOLTZAP_SERVER_URL` (upstream convention) and
  `ZAPBOT_MOLTZAP_SERVER_URL` (bridge convention) so neither side has to
  translate.
- **`bin/zapbot-team-init` writes `~/.zapbot/projects.json`** instead of
  `agent-orchestrator.yaml`. The schema (`{ "<slug>": { repo, defaultBranch } }`)
  matches `bin/zapbot-orchestrator.ts`'s `ProjectsFileSchema`. Both
  full-init and `--add-repo` paths use `jq` to merge entries atomically.
- **`CLAUDE.md` + `ARCHITECTURE.md`** rewritten to describe the
  bridge → orchestrator → claude-session topology. The "Topology after the
  work" diagram from the epic is now the canonical architecture diagram. The
  module table reflects `src/orchestrator/{runner,server,spawn-broker,errors}`
  + `bin/zapbot-{orchestrator,spawn-mcp}.ts`. The error-model section names
  the new `OrchestratorError` tags.
- **`ORCHESTRATOR_DOCTRINE` prompt** in `src/orchestrator/control-event.ts`
  rewritten for the new control plane. Bullets now reference the
  `request_worker_spawn` MCP tool, `bin/zapbot-spawn-mcp.ts`,
  `src/orchestrator/spawn-broker.ts`, `src/orchestrator/runner.ts`, and
  `claude -p --resume` instead of the deleted roster manager / peer-message
  decoder / two-gate budget machinery. Defensive tests guard against
  regression of deleted-module names.

### Fixed

- **`ensureProjectCheckout` no longer trips on `worktree add`.** Switched
  from `git clone --bare` to `git init --bare` + `git remote add origin` +
  `git fetch origin`. The clone-bare path populated `refs/heads/<branch>`
  from the remote, which then conflicted with `git worktree add --track -b
  <branch> ... origin/<branch>` ("a branch named '<branch>' already exists").
- **claude subprocess args.** Two bugs in `productionSpawnClaude`:
  `--mcp-config` is variadic so the next positional was consumed as another
  config path (fixed by adding `--` before the message), and the default
  `--output-format text` mode never prints `session_id` so every clean exit
  looked like `LeadProcessFailed` (fixed by passing
  `--output-format json`, which emits `session_id` in every event).

### Removed

- **`agent-orchestrator.yaml`** as a configuration source for `bin/zapbot-team-init`
  and `start.sh`'s AO startup. The bridge process still consumes
  `agent-orchestrator.yaml` for its own repo routing (loaded via `ZAPBOT_CONFIG`);
  the orchestrator reads `~/.zapbot/projects.json`.
- **AO startup logic in `start.sh`** (~170 LOC) including `start_ao_once`,
  duplicate-session retry, dashboard-ready polling, the `claude-moltzap`
  plugin injection script, and the `AO_LOG_FILE` / `AO_CONFIG_FILE` plumbing.
- **AO worker plugin + worker channel.** Deleted
  `worker/ao-plugin-agent-claude-moltzap/` (3 files / 574 LOC),
  `bin/moltzap-claude-channel.ts`, and `src/moltzap/worker-channel.ts`.
  Workers spawn through `@moltzap/runtimes.ClaudeCodeAdapter` instead of
  the local plugin. Dropped `@aoagents/ao-plugin-agent-claude-code` from
  `package.json` deps.
- **Orphaned orchestrator modules.** `src/orchestrator/{peer-message,roster,
  budget,runtime}.ts` (~1,600 LOC) — these powered the AO roster manager +
  two-gate budget. After PR #376 wired the bridge directly to the orchestrator,
  these had zero production consumers and were deleted.
- **Operator-facing AO references** in `setup` (no longer installs
  `@aoagents/ao` globally), `README.md`, `CONTRIBUTING.md`, and 6 stale code
  comments. Final grep is clean modulo the "do not reintroduce" forbid-language
  + 4 negative test assertions.
- **`test/integration/moltzap-mcp-stdio-smoke.integration.test.ts`** —
  exercised `bin/moltzap-claude-channel.ts`, deleted in PR #378. Replaced by
  the new end-to-end-webhook integration smoke test.
- **Four AO-coupled `start.sh` integration tests** in `test/config-reload.test.ts`
  (claude-moltzap plugin injection, duplicate-session retry, local-only with a
  stale bridge URL, github-demo with a dead public URL). Replaced by a single
  string-only assertion that the new boot order is wired correctly.

## 0.5.4 (2026-04-25)

Stop durable comments from mirroring to the wrong repository.

### Fixed

- **Cross-repo PR cross-references no longer mirror to the anchor repo.** When a GitHub issue is referenced from a PR in a different repository, the durable comment mirror path now correctly skips that link. Previously it would post the mirror comment to the original issue's repo using the cross-repo PR's number, which either hit a 404 or (worse) commented on an unrelated issue. The mirror code now compares `event.source.{issue,pull_request}.repository_url` against the anchor repo and only mirrors same-repo PRs. Fail-closed when `repository_url` is absent.

## 0.5.3 (2026-04-25)

Tighten reliability: parallelize roster shutdown, use constant-time HMAC, make boot probe non-fatal, and harden a few small spots flagged in pre-landing review.

### Changed

- **`retireRoster` now retires members in parallel** via `Promise.allSettled` instead of a sequential `for await` loop, and `releaseRosterSession` always fires (even on partial failure) so the roster bridge session never leaks.
- **Post-boot reachability probe is non-fatal** — bridge in `github-demo` mode no longer shuts down when it can't reach its own public URL, so hairpin-NAT and split-horizon DNS deployments keep running.
- **`src/logger.ts` mkdirSync wrapped in try/catch** — log dir init no longer crashes on read-only or missing-home environments.
- **`start.sh` cleanup trap removes `AO_CONFIG_FILE_RAW`** — covers the edge case where the script dies between `mktemp` and `mv`.
- **`bin/zapbot-team-init` uses `pwd -P`** — physical-path resolution is explicit, matching `start.sh`'s canonical-path comparison.

### Fixed

- **`verifySignature` uses `crypto.timingSafeEqual`** instead of `Buffer.equals`, eliminating the timing-side-channel risk in webhook HMAC verification.
- **Removed dead `BootProbeFailed` variant** from `ShutdownReason` and its `exitCodeFor` case — no path constructed it after the probe became non-fatal.
- **Stale docstrings** in `src/bridge.ts` and `src/bridge-process.ts` that still referred to the old fail-fast probe behavior.

### Added

- **Trust-model comment** on `decodeRosterSpec` clarifying that input arrives from an untrusted MoltZap network boundary; callers must handle the `Err` branch.
- **Test coverage** for `retireRoster` error branches (`firstErr`, `firstFailure`, empty `liveEntries`, precedence) and the non-fatal boot probe path.

## 0.5.2 (2026-04-25)

Remove dead v2 code, fix macOS test failures, and simplify the moltzap plugin.

### Changed

- **`@aoagents/ao-plugin-agent-claude-code` is now a regular dependency** — installed via `bun install` rather than requiring a global AO toolchain. The moltzap plugin uses a static ESM import instead of a 35-line runtime path resolver.
- **Canonical path comparison in `start.sh`** — the embedded Node block now uses `fs.realpathSync` (with `path.resolve` fallback) when matching a project path against the orchestrator config, so symlinked project roots (macOS `/var` → `/private/var`) resolve correctly.
- **`bin/zapbot-team-init` writes canonical paths** — uses `pwd -P` to guarantee the physical path is stored in `agent-orchestrator.yaml`, matching what `start.sh` produces at runtime.
- **Logger directory created at module load** — `~/.zapbot/logs` is now created once when the module initialises instead of on every log call.

### Fixed

- **macOS BSD `mktemp` crash** — `start.sh` called `mktemp` with a suffix inside the template (`zapbot-ao-config.XXXXXX.yaml`), which BSD mktemp does not support. The fix creates the temp file without a suffix, then renames it to add `.yaml`.
- **11 moltzap-mcp-config-decode tests** that failed because the builtin claude plugin required a global bun install. The package is now a regular dep.
- **1 config-reload test** that failed due to symlinked temp dirs on macOS — fixed by the `realpathSync` path comparison.
- **1 team-init test** that compared the wrong path form — fixed by asserting against `realpathSync(projectDir)`.
- **Removed TOCTOU `existsSync` guard** before `unlinkSync` in `src/orchestrator/runtime.ts` — the surrounding try-catch already handles the not-found case.

### Removed

- **`v2/` dead code** — 14 files that were excluded from `tsconfig.json` and had zero live importers. Five v2-prefixed test files that duplicated src tests are also gone.

## 0.5.1 (2026-04-19)

Finish the ao-native bridge path and make MoltZap session provisioning real.

### Added

- **MoltZap runtime provisioning** — zapbot now decodes `ZAPBOT_MOLTZAP_*` env at boot and forwards real `MOLTZAP_*` credentials to spawned `ao` sessions.
- **Per-session MoltZap registration mode** — when `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` is configured, zapbot registers a fresh MoltZap agent for each dispatch and passes that key to the child session.
- **Supervisor and allowlist implementations** — `src/moltzap/supervisor.ts` and `src/moltzap/identity-allowlist.ts` are now fully implemented and covered by tests.
- **Dispatcher env coverage** — tests now verify that `MOLTZAP_*` values actually reach the spawned `ao` process.

### Changed

- **Bridge docs and onboarding** — README, architecture notes, contributing guide, and Claude instructions now describe the shipped `ao`-native runtime instead of the removed team/state-machine flow.
- **Bridge config** — `BridgeConfig` now carries typed MoltZap runtime config and surfaces `MoltzapProvisionFailed` as a dispatch-visible error.

### Removed

- **Stale planning artifact** — deleted the old `plan.md` that described an unrelated Supabase plan.
- **Dead smoke script** — removed the old `test/e2e-smoke.sh` script that still referenced deleted workflow/history APIs.

## 0.5.0 (2026-04-16)

Talk to zapbot in comments. @mention the bot in any issue or PR to trigger workflows, check status, or forward messages to running agents.

### Added

- **@mention triggers** — type `@zapbot plan this`, `@zapbot status`, `@zapbot help`, or any command in a GitHub comment. The bot reacts with eyes emoji, auto-assigns itself, and dispatches the right agent. Mentions inside code blocks and blockquotes are ignored.
- **Assignment-based entry point** — assigning an issue to the bot starts a workflow. Labels determine which agent spawns (triage, planner, implementer, QE).
- **Nudge-before-kill** — heartbeat checker sends "continue" to idle agents via tmux before timing out. Reduces unnecessary agent restarts.
- **One-click deploy configs** — Render and Railway deploy buttons in the README. GitHub App setup guide with step-by-step instructions.
- **Teammate install** — `curl | bash` one-liner downloads skill files without cloning the repo.

### Changed

- **GitHub client migrated to Octokit** — replaced hand-rolled REST client with `@octokit/rest`. GitHub App auth uses `@octokit/auth-app` for automatic token refresh.
- **Comment prefix removed** — bot comments no longer start with `**Zapbot:**` (redundant when the bot account is visible).
- **Mention parsing extracted** — `parseMentionCommand()` and `stripQuotedContent()` in `src/webhook/mapper.ts`, fully tested and importable.

### Fixed

- **Cleanup workflow ID parsing** — uses DB lookup instead of broken regex that couldn't parse `wf-owner-repo-N` format.
- **Live agent progress** — GitHub comments update in real time as agents work.
- **Claude Code project path encoding** — fixed path encoding for project directories with special characters.
- **Worktree path backfill** — agents spawned before tracking fix now get their worktree path populated.

## 0.4.3 (2026-04-15)

Railway gateway service. Static HTTPS URL replaces ngrok for GitHub webhooks.

### Added

- **Railway gateway** (`gateway/`) — lightweight HTTP proxy that receives GitHub webhooks at a static Railway URL and forwards them to registered local bridge instances. Bridges register on startup, deregister on shutdown. No more ephemeral ngrok URLs.
- **Bridge registration API** — `POST /api/bridges/register` and `DELETE /api/bridges/register` with shared-secret auth (`GATEWAY_SECRET`).
- **Bridge liveness sweep** — gateway pings registered bridges periodically, marks unresponsive ones inactive, and reaps long-dead entries to prevent unbounded memory growth.
- **31 gateway tests** — registry unit tests (13) and endpoint integration tests (18) covering all endpoints, auth, forwarding, and error paths.

### Changed

- **Agent prompt templates** — triage, planner, and implementer agent rules now reference gstack skills (`/simplify`, `/review`, `/investigate`, `/ship`, `/document-release`).

## 0.4.2 (2026-04-14)

Three fixes that make the multi-repo agent pipeline work end-to-end.

### Fixed

- **Port configuration** — `start.sh` now correctly passes `PORT` to AO and `ZAPBOT_PORT` to the bridge, so they bind to different ports. Previously both tried to use 3000, causing a systemd crash loop.
- **Agent spawning** — replaced non-existent `ao spawn --project` flag with `AO_PROJECT_ID` and `AO_CONFIG_PATH` env vars. Agents now spawn successfully across all repos.

### Added

- **GitHub comments on every transition** — every state change posts a `**Zapbot:**` comment on the issue explaining what happened and what to do next. Approvals include @mentions. 16 transition points now have comments.

### Changed

- **248 tests** (up from 147). Added config-reload and multi-repo test suites.

## 0.4.1 (2026-04-14)

Hardening, operations, and the bugs you'd find in week one of real usage.

### Added

- **`/zap` command** — single entry point for zapbot. Onboarding wizard, publish, status, help.
- **Systemd service template** — `setup --server` generates a service file. Auto-start on boot, auto-restart on crash, config reload via `systemctl reload zapbot-bridge`.
- **SIGHUP config hot-reload** — bridge re-reads .env + YAML on signal, validates before applying, keeps old config if invalid.
- **Side effect retry** — GitHub API effects retry once (2s delay). Failed effects get a reconciliation comment on the issue.
- **Plannotator integration test** — catches broken subcommands before they ship silently.
- **Skill-aware agent rules** — implementer and QE templates use /simplify, /review, /investigate, /ship.

### Changed

- **ZAPBOT_API_KEY** — renamed from GITHUB_WEBHOOK_SECRET everywhere (27 replacements). One name, one purpose.
- **Plannotator command** — `plannotator share` (nonexistent) → `plannotator annotate` (correct). Uses timeout for headless environments.
- **No silent failures** — plannotator errors are printed, not swallowed.
- **DRY triage** — extracted `createTriageWorkflow()` helper, removing 40 lines of duplication.
- **Atomic file writes** — team-init and start.sh use mktemp + trap.

### Fixed

- `/zap` skill discovery — renamed from `zapbot-meta` so Claude Code finds it by directory name.
- start.sh warns and exits if systemd service is active (prevents port conflict).
- team-init auto-reloads bridge via `systemctl reload` after config changes.
- Null delivery ID warning for visibility on manual API calls.

### Tests

- 139 → 147 tests: systemd template validation, plannotator integration, callback contract.

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

- **Multi-repo webhook routing** — Bridge loads `agent-orchestrator.yaml` via the runtime config loader (`src/config/*`), routes webhooks by `repository.full_name`, and rejects unconfigured repos with 403.
- **Per-repo webhook secrets** — Each project can specify its own `secretEnvVar` in the config. HMAC verification resolves the per-repo secret first, falls back to shared `ZAPBOT_API_KEY`.
- **Repo-scoped plannotator tokens** — Callback tokens now carry repo context. The bridge stores them locally with a 24-hour TTL instead of proxying to AO. Resolves repo via: token store → request body → `ZAPBOT_REPO` env var.
- **Project-scoped `ao spawn`** — The spawner passes `--project <name>` so AO routes to the correct project.
- **Webhook cleanup on shutdown** — `start.sh` tracks webhook IDs and deactivates them when you Ctrl+C, preventing stale webhook deliveries.
- **Multi-repo webhook registration** — `start.sh` registers webhooks on all repos from the config via a single ngrok tunnel.

### For contributors

- New runtime config loader coverage in `test/config-loader.test.ts`
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
