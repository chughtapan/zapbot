/**
 * orchestrator/errors — tagged-union error vocabulary for the
 * Claude-Code-as-lead orchestrator process (epic #369, sub-issue #370).
 *
 * Owns: the OrchestratorError union for every fault produced inside the
 * orchestrator (HTTP server, claude-runner, spawn-broker, MCP-tool proxy)
 * plus a renderer that yields the operator-facing diagnostic block.
 *
 * Does not own: bridge-side error rendering. When the orchestrator is
 * unreachable the bridge surfaces its own `LauncherError` tag (one of the
 * four bridge-visible tags below). The renderer here is for orchestrator
 * stdout/stderr logs and for the JSON body returned over `POST /turn`.
 *
 * Cross-link to LauncherError (in `src/launcher/errors.ts` on
 * `feat/launcher-typescript-port`; not present on `main`): when the
 * launcher branch lands the four tags `OrchestratorUnreachable`,
 * `OrchestratorAuthFailed`, `FleetSpawnFailed`, `LeadSessionCorrupted` are
 * appended to LauncherError's union and the AO-era tags `AoSpawnFailed`
 * and `AoNotReady` are dropped at the same time. The other tags below
 * stay orchestrator-internal and never leak to the bridge.
 */

import { absurd } from "../types.ts";

export type OrchestratorError =
  // ── bridge-visible (mirror to LauncherError when launcher branch lands) ──
  | { readonly _tag: "OrchestratorUnreachable"; readonly url: string; readonly cause: string }
  | { readonly _tag: "OrchestratorAuthFailed"; readonly reason: "missing-header" | "secret-mismatch" }
  | {
      readonly _tag: "FleetSpawnFailed";
      readonly agentName: string;
      readonly cause: "ready-timeout" | "process-exited" | "config-invalid";
      readonly detail: string;
    }
  | {
      readonly _tag: "LeadSessionCorrupted";
      readonly projectSlug: string;
      readonly sessionPath: string;
      readonly reason: string;
    }
  // ── orchestrator-internal ─────────────────────────────────────────────
  | { readonly _tag: "TurnRequestInvalid"; readonly reason: string }
  | { readonly _tag: "SpawnRequestInvalid"; readonly reason: string }
  | { readonly _tag: "ProjectDirMissing"; readonly projectSlug: string; readonly path: string }
  | {
      readonly _tag: "LeadProcessFailed";
      readonly projectSlug: string;
      readonly exitCode: number | null;
      readonly stderrTail: string;
    }
  | {
      readonly _tag: "LockTimeout";
      readonly projectSlug: string;
      readonly waitedMs: number;
    }
  | { readonly _tag: "GitFetchFailed"; readonly projectSlug: string; readonly stderrTail: string }
  | {
      readonly _tag: "ProjectCheckoutFailed";
      readonly projectSlug: string;
      readonly stage: "clone" | "worktree-add" | "fetch";
      readonly stderrTail: string;
    }
  | {
      readonly _tag: "McpConfigWriteFailed";
      readonly projectSlug: string;
      readonly path: string;
      readonly cause: string;
    };

/**
 * Render an `OrchestratorError` as a one-line summary plus indented
 * `cause` / `diagnose` / `fix` block. Mirrors `describeLauncherError`'s
 * shape so operator output is consistent across the bridge → orchestrator
 * boundary.
 */
export function describeOrchestratorError(error: OrchestratorError): string {
  switch (error._tag) {
    case "OrchestratorUnreachable":
      return [
        `OrchestratorUnreachable: ${error.url}`,
        `  cause:    ${error.cause}`,
        `  diagnose: curl -v ${error.url}/healthz`,
        `  fix:      ensure 'bun run bin/zapbot-orchestrator.ts' is running and ZAPBOT_ORCHESTRATOR_URL is correct`,
      ].join("\n");
    case "OrchestratorAuthFailed":
      return [
        `OrchestratorAuthFailed: ${error.reason}`,
        `  cause:    bridge → orchestrator auth rejected (${error.reason})`,
        `  diagnose: jq .orchestratorSecret ~/.zapbot/config.json`,
        `  fix:      regenerate orchestratorSecret and restart both bridge and orchestrator`,
      ].join("\n");
    case "FleetSpawnFailed":
      return [
        `FleetSpawnFailed: agent='${error.agentName}' cause=${error.cause}`,
        `  cause:    ${error.detail}`,
        `  diagnose: tail -50 ~/.zapbot/projects/<slug>/logs/worker-<agentId>.log`,
        `  fix:      check moltzap server is running, check claude CLI is on PATH`,
      ].join("\n");
    case "LeadSessionCorrupted":
      return [
        `LeadSessionCorrupted: ${error.projectSlug}`,
        `  cause:    ${error.reason}`,
        `  diagnose: jq . ${error.sessionPath}`,
        `  fix:      session.json moved aside as ${error.sessionPath}.corrupt-<unix-ms>; next webhook starts fresh`,
      ].join("\n");
    case "TurnRequestInvalid":
      return [
        `TurnRequestInvalid`,
        `  cause:    ${error.reason}`,
        `  diagnose: inspect the bridge → /turn JSON body for missing or wrong-typed fields`,
        `  fix:      align bridge encoder with TurnRequest schema in src/orchestrator/server.ts`,
      ].join("\n");
    case "SpawnRequestInvalid":
      return [
        `SpawnRequestInvalid`,
        `  cause:    ${error.reason}`,
        `  diagnose: inspect MCP request_worker_spawn input against SpawnWorkerRequest schema`,
        `  fix:      align lead-session tool call with the inputSchema published by zapbot-spawn-mcp`,
      ].join("\n");
    case "ProjectDirMissing":
      return [
        `ProjectDirMissing: ${error.projectSlug}`,
        `  cause:    expected directory not present at ${error.path}`,
        `  diagnose: ls -la ${error.path}`,
        `  fix:      ensure ~/.zapbot/projects.json declares this slug; restart orchestrator (SIGHUP)`,
      ].join("\n");
    case "LeadProcessFailed":
      return [
        `LeadProcessFailed: ${error.projectSlug} exit=${error.exitCode ?? "null"}`,
        `  cause:    claude subprocess exited non-zero`,
        `  diagnose: tail -50 ~/.zapbot/projects/${error.projectSlug}/logs/turn-*.log`,
        `  fix:      ${error.stderrTail || "(no stderr captured)"}`,
      ].join("\n");
    case "LockTimeout":
      return [
        `LockTimeout: ${error.projectSlug} waited=${error.waitedMs}ms`,
        `  cause:    another webhook still holds the per-project lock`,
        `  diagnose: ls -la ~/.zapbot/projects/${error.projectSlug}/lock`,
        `  fix:      retry — GitHub redelivers in 30-60s`,
      ].join("\n");
    case "GitFetchFailed":
      return [
        `GitFetchFailed: ${error.projectSlug}`,
        `  cause:    git fetch against bare clone failed`,
        `  diagnose: cd ~/.zapbot/clones/${error.projectSlug}.git && git fetch`,
        `  fix:      ${error.stderrTail || "(no stderr captured)"}`,
      ].join("\n");
    case "ProjectCheckoutFailed":
      return [
        `ProjectCheckoutFailed: ${error.projectSlug} stage=${error.stage}`,
        `  cause:    ${error.stderrTail || "(no stderr captured)"}`,
        `  diagnose: inspect ~/.zapbot/clones/${error.projectSlug}.git and ~/.zapbot/projects/${error.projectSlug}/checkout`,
        `  fix:      remove the partial state and re-run orchestrator boot (idempotent)`,
      ].join("\n");
    case "McpConfigWriteFailed":
      return [
        `McpConfigWriteFailed: ${error.projectSlug}`,
        `  cause:    ${error.cause}`,
        `  diagnose: ls -la ${error.path}`,
        `  fix:      check filesystem permissions on the parent directory`,
      ].join("\n");
    default:
      return absurd(error);
  }
}
