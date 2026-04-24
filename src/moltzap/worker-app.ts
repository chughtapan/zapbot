/**
 * moltzap/worker-app — worker-process attach-only entrypoint.
 *
 * Anchors: sbd#199 acceptance items 1, 7, 8 (zapbot#336 path b — workers
 * never call `apps/register`).
 *
 * **Replaces `bootApp(role)` from `app-client.ts`** for worker
 * processes (architect, implementer, reviewer roles). The `app-client.ts`
 * `bootApp` function is deleted in the corresponding `implement-staff`
 * PR. Worker processes call `joinWorkerSession(role, ...)` instead.
 *
 * **Why a separate entrypoint.** The `MoltZapApp.start()` API
 * unconditionally calls `apps/register` (see
 * `~/moltzap/packages/app-sdk/src/app.ts:start`); a worker process
 * calling `start()` would stomp the bridge's union manifest
 * (zapbot#336). Workers therefore bypass `start()` and use the SDK's
 * `client` escape hatch (`MoltZapApp.client`) to:
 *   1. `auth/connect` with the worker's `agentKey` (provisioned by the
 *      bridge into spawn env via `buildMoltzapSpawnEnv` —
 *      `MOLTZAP_AGENT_KEY`).
 *   2. Listen for `app/sessionReady` events: the upstream server emits
 *      this when the bridge's `apps/create({invitedAgentIds})` admits
 *      this worker. The handler synthesizes an `AppSessionHandle`
 *      from the event payload (mirrors `MoltZapApp.handleSessionReady`).
 *   3. Forward `app.onMessage(key, handler)` and `app.send(key, parts)`
 *      to the same SDK pathways used by `bootApp` today, retaining
 *      role-pair gates (`sendableKeysForRole` / `receivableKeysForRole`).
 *
 * Spec rev 2 Invariant 1 ("one MoltZapApp per process") is reinterpreted
 * for workers as "one MoltZap connection per process": the worker
 * handle is a `MoltZapApp` instance whose `start()` is never invoked.
 * The architect call here is that this satisfies the invariant in
 * spirit — a singleton SDK object per process — without the manifest
 * stomp the strict-`start()` interpretation would require.
 *
 * **No-register guarantee.** This module's public surface MUST NOT
 * expose any code path that reaches `apps/register`. Compliance is
 * verified by `test/moltzap-worker-app.test.ts` ("never sends
 * apps/register RPC").
 */

import { Effect } from "effect";
import type { Message, Part, WsClientLogger } from "@moltzap/app-sdk";
import type { ConversationKey } from "./conversation-keys.ts";
import type { SessionRole, WorkerRole } from "./session-role.ts";
import type {
  HandlerRegistrationError,
  SendErrorChannel,
} from "./app-client.ts";

// ── Boot config ─────────────────────────────────────────────────────

export interface WorkerJoinConfig {
  readonly serverUrl: string;
  /** AgentKey minted by the bridge and passed via spawn env. */
  readonly agentKey: string;
  readonly role: WorkerRole;
  readonly logger?: WsClientLogger;
  readonly env?: Record<string, string | undefined>;
  /**
   * The bridge's senderId, propagated via spawn env. Used to stamp
   * outbound notifications to MCP and to filter inbound messages by
   * `senderId === bridgeId` for telemetry. Required: workers cannot
   * synthesize this; the bridge must supply it.
   */
  readonly bridgeAgentId: string;
}

export type WorkerJoinError =
  | { readonly _tag: "WorkerJoinAlreadyBooted" }
  | {
      readonly _tag: "WorkerJoinConnectFailed";
      readonly cause: string;
    }
  | {
      readonly _tag: "WorkerJoinNoSessionReady";
      readonly reason: string;
    }
  | {
      readonly _tag: "WorkerJoinDecodeFailed";
      readonly reason: string;
    };

// ── Public handle ───────────────────────────────────────────────────

export interface WorkerAppHandle {
  readonly role: WorkerRole;
  readonly sessionId: string;
  readonly conversations: Readonly<Record<ConversationKey, string>>;
  readonly bridgeAgentId: string;
}

/**
 * Connect as a worker, wait for `app/sessionReady`, return a worker
 * handle. Singleton-enforced (one connection per worker process).
 *
 * Workers never call `apps/register` or `apps/create`. The bridge has
 * already created the session; this call only joins it.
 *
 * Timeout policy (architect call): if `app/sessionReady` does not arrive
 * within `joinTimeoutMs` (default 30_000), fail with
 * `WorkerJoinNoSessionReady`. Implementation may surface a typed retry
 * channel; v1 fails fast.
 */
export function joinWorkerSession(
  config: WorkerJoinConfig,
  joinTimeoutMs?: number,
): Effect.Effect<WorkerAppHandle, WorkerJoinError> {
  throw new Error("not implemented");
}

/** Return the joined worker handle, or `null` if `joinWorkerSession` has not run. */
export function currentWorkerApp(): WorkerAppHandle | null {
  throw new Error("not implemented");
}

/**
 * Disconnect from the worker session. Idempotent. Called at process
 * exit; per-spawn ephemeral, so `closeSession` is NOT called from the
 * worker (only the bridge can close).
 */
export function shutdownWorkerApp(): Effect.Effect<void, never> {
  throw new Error("not implemented");
}

// ── Send (role-gated) ───────────────────────────────────────────────

/**
 * Send `parts` on `key` from this worker. Role-gated: a worker may only
 * send on keys in `sendableKeysForRole(role)`. Failures use the same
 * `SendErrorChannel` shape `app-client.ts` exposes today, so the MCP
 * adapter (`mcp-adapter.ts`) does not need to discriminate between
 * worker-app and bridge-app send paths (the bridge has no send path —
 * see `bridge-app.ts` silence invariant).
 *
 * Pre-RPC role check: same shape as `app-client.sendOnKey`. Architect
 * names that the role gate is enforced HERE in the worker handle, not
 * in a shared utility, so the bridge handle (which has no role) cannot
 * be passed by mistake.
 */
export function workerSend(
  handle: WorkerAppHandle,
  key: ConversationKey,
  parts: readonly Part[],
): Effect.Effect<void, SendErrorChannel> {
  throw new Error("not implemented");
}

// ── Receive (role-gated) ────────────────────────────────────────────

export type WorkerMessageHandler = (message: Message) => void | Promise<void>;

/**
 * Register an inbound handler for `key` on this worker. Role-gated:
 * a worker may only register on keys in `receivableKeysForRole(role)`.
 *
 * Invariant 6 (verbatim): the receiver trusts the key. This function
 * does NOT inspect `message.senderId` or a role field in the body.
 */
export function workerOnMessage(
  handle: WorkerAppHandle,
  key: ConversationKey,
  handler: WorkerMessageHandler,
): HandlerRegistrationError | null {
  throw new Error("not implemented");
}

// Test-only escape hatch.
export function __resetWorkerAppForTests(): void {
  throw new Error("not implemented");
}
