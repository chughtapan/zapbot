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
 *
 * Implementer (sub-issue #3): switch on `error._tag` and end the switch
 * with `default: return absurd(error);` (import `absurd` from `../types.ts`).
 * Each branch returns the 4-line summary/cause/diagnose/fix block; the
 * reference wording lives in the design doc § "Errors" on epic #369.
 */
export function describeOrchestratorError(error: OrchestratorError): string {
  void error;
  throw new Error("not implemented: describeOrchestratorError");
}
