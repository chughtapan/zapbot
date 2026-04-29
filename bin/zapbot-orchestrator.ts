#!/usr/bin/env bun
/**
 * bin/zapbot-orchestrator — entrypoint for the long-lived orchestrator
 * process (epic #369 D2). Mirrors `bin/webhook-bridge.ts`'s shape:
 * env handoff, top-level fatal catch, all heavy lifting in
 * `src/orchestrator/*`.
 *
 * Boot sequence (implemented by `runOrchestratorProcess`):
 *   1. Decode `~/.zapbot/config.json` (loadZapbotConfig from
 *      `src/launcher/config.ts` once the launcher branch lands; until
 *      then a local decoder).
 *   2. Mint or read `orchestratorSecret` (added to config schema in
 *      sub-issue #9).
 *   3. Construct LaunchDeps (spawn / fetch / clock / log / fs / randomHex).
 *   4. Resolve moltzap workspace paths (claudeBin, channelDistDir,
 *      moltzapRepoRoot) from the vendored submodule.
 *   5. Construct stub RuntimeServerHandle (spawn-broker.ts).
 *   6. Construct SpawnBrokerHandle.
 *   7. For every project in `~/.zapbot/projects.json` (added in
 *      sub-issue #9), call ensureProjectCheckout to provision the
 *      bare clone + worktree + .mcp.json.
 *   8. Construct RunnerDeps.
 *   9. Construct ServerDeps and call startOrchestratorServer.
 *  10. Install SIGINT/SIGTERM handlers: server.close → broker.stopAll
 *      → process.exit(0). On SIGHUP: re-read projects.json and call
 *      ensureProjectCheckout for any new projects (no-op for known ones).
 */

import { Effect } from "effect";
import type { OrchestratorError } from "../src/orchestrator/errors.ts";

// ── Public surface ──────────────────────────────────────────────────

/**
 * Boot the orchestrator. Resolves never on the happy path; fails with
 * `OrchestratorError` if config / checkout provisioning / port-bind
 * fails before the server is up. Once the server is up, fatal errors
 * are logged but do NOT exit the process — the orchestrator outlives
 * any single bad webhook (epic #369 invariant: "orchestrator outlives
 * bridge"; same logic for in-flight worker fleets).
 */
export function runOrchestratorProcess(
  env: NodeJS.ProcessEnv,
): Effect.Effect<never, OrchestratorError, never> {
  void env;
  throw new Error("not implemented: runOrchestratorProcess");
}

// ── Top-level shim ──────────────────────────────────────────────────
// Implementer (sub-issue #3): mirror bin/webhook-bridge.ts's shim:
//
//   process.on("unhandledRejection", (e) => { console.error(...); });
//   Effect.runPromise(runOrchestratorProcess(process.env)).catch((e) => {
//     console.error(`[orchestrator] Fatal: ${...}`);
//     process.exit(1);
//   });
//
// Kept out of the stub so the file type-checks without an import of
// process.* at the module top level.
