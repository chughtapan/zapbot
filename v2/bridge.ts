/**
 * v2/bridge — the thinned webhook bridge.
 *
 * v1's `bin/webhook-bridge.ts` was 1724 LOC carrying: HTTP server, HMAC
 * verify, mention dispatch, state-machine apply, side-effect executor,
 * workflow/agent HTTP APIs, plannotator callback handler, startup
 * recovery, shutdown. v2 keeps the HTTP server + HMAC + mention
 * dispatch + gateway registration + SIGHUP reload + shutdown. Everything
 * else in v1's bridge is deleted.
 *
 * Target LOC after the strip: ≤ 1100 (spec acceptance criterion 3).
 *
 * Principle 4 (Exhaustiveness): every webhook classification branch that
 * reaches the bridge is handled. The `handleClassifiedWebhook` switch ends
 * in `absurd` against the `ClassifiedWebhook` union.
 */

import type { ClassifiedWebhook } from "./gateway.ts";
import type {
  BotUsername,
  DispatchError,
  InstallationToken,
  ProjectName,
  RepoFullName,
  Result,
} from "./types.ts";

// ── Boot config ─────────────────────────────────────────────────────

export interface BridgeConfig {
  readonly port: number;
  readonly publicUrl: string;
  readonly gatewayUrl: string;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: string;
  /** repo full_name → project name + secret env var + default branch */
  readonly repos: ReadonlyMap<RepoFullName, RepoRoute>;
}

export interface RepoRoute {
  readonly projectName: ProjectName;
  readonly webhookSecretEnvVar: string;
  readonly defaultBranch: string;
}

// ── Lifecycle ───────────────────────────────────────────────────────

export interface RunningBridge {
  readonly stop: () => Promise<void>;
  readonly reload: (nextConfig: BridgeConfig) => Promise<void>;
}

/**
 * Boot the HTTP server, register every configured repo with the gateway,
 * start heartbeats, install SIGHUP → reload. Does not block on webhook
 * traffic; returns immediately with a handle the caller uses to stop or
 * reload. Reload is re-entrant: a second SIGHUP while one reload is in
 * flight is ignored with a log line.
 */
export function startBridge(_config: BridgeConfig): Promise<RunningBridge> {
  throw new Error("not implemented");
}

// ── Request routing (pure over the parsed webhook) ──────────────────

/**
 * Dispatch a classified webhook to its downstream action:
 * - `ignore` → no-op, returns `Ok`.
 * - `mention_command` → check command permissions, parse intent, call
 *   `v2/ao/dispatcher.dispatch` when the command is `plan_this` or
 *   `investigate_this`, post an ack comment.
 *
 * Errors from dispatch propagate as `Err`. The caller (the HTTP handler
 * in `startBridge`) is responsible for turning that into an HTTP response
 * shape and logging; this function does not call `console` or `log`.
 */
export function handleClassifiedWebhook(
  _classified: ClassifiedWebhook,
  _ctx: BridgeHandlerContext
): Promise<Result<HandleOutcome, DispatchError>> {
  throw new Error("not implemented");
}

export interface BridgeHandlerContext {
  readonly mintToken: () => Promise<InstallationToken>;
  readonly config: BridgeConfig;
}

export type HandleOutcome =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "dispatched"; readonly repo: RepoFullName; readonly session: string }
  | { readonly kind: "unauthorized"; readonly actor: string }
  | { readonly kind: "command_unknown"; readonly raw: string };
