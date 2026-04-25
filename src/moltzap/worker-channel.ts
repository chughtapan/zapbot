/**
 * moltzap/worker-channel — Claude-Code worker entrypoint via the
 * `@moltzap/claude-code-channel` single-agent gateway.
 *
 * Anchors: sbd#199 acceptance items 1, 7, 8 (zapbot#336 path b — workers
 * never call `apps/register` or `apps/create`); operator correction
 * (https://github.com/chughtapan/safer-by-default/issues/199#issuecomment-4316798423):
 * "workers are not apps. workers are endpoints/peers — they connect via
 * our claude channel."
 *
 * **What this module is.** A typed wrapper around `bootClaudeCodeChannel`
 * from `@moltzap/claude-code-channel`. The channel package is the
 * single-agent gateway that ships from sbd#172: it owns the WS connect
 * (auth/connect with `agentKey`), translates inbound MoltZap messages
 * into Claude-Code channel notifications (`notifications/claude/channel`),
 * exposes the MCP `reply` tool to Claude Code, and owns its routing
 * state (inbound message_id → chat_id; reply targets the inbound chat_id
 * by default).
 *
 * **What this module is NOT.** Not a `MoltZapApp` consumer. Worker
 * processes do NOT import `@moltzap/app-sdk`. They do not own a manifest.
 * They do not call `apps/register`, `apps/create`, or `apps/closeSession`.
 * They are channel-plugin peers, admitted to bridge-owned sessions by
 * the bridge's `apps/create({invitedAgentIds})` call before spawn.
 *
 * **Replaces** `worker-app.ts` (deleted in this revision). The previous
 * design routed workers through the SDK's `MoltZapApp.client` no-`start()`
 * escape hatch; the corrected design routes them through the channel
 * package, which is the precedent pattern (mirrors `OpenClaw/NanoClaw`
 * channel plugins per sbd#197 Round 4).
 *
 * **Boot sequence (worker process, in order):**
 *   1. `loadWorkerChannelEnv(env)` — Principle 2 boundary decode of
 *      `MOLTZAP_SERVER_URL`, `MOLTZAP_AGENT_KEY`, optional
 *      `MOLTZAP_BRIDGE_AGENT_ID` for telemetry, and `AO_CALLER_TYPE`
 *      for role tagging.
 *   2. `bootWorkerChannel(config)` — internally calls
 *      `bootClaudeCodeChannel({ serverUrl, agentKey, logger })`. The
 *      channel package opens the WS, authenticates as the worker's
 *      agent, and starts forwarding inbound messages to MCP. No session
 *      handshake is performed at this layer — the bridge's prior
 *      `apps/create({invitedAgentIds: [thisWorkerSenderId]})` admits
 *      this worker to the manifest's conversations server-side.
 *   3. Returned `WorkerChannelHandle` exposes `stop()` only. The
 *      channel-plugin's `Handle.push` is internal — workers do not
 *      inject custom MCP notifications; only the channel-plugin emits
 *      them.
 *
 * **No-register, no-create guarantee.** This module's surface contains
 * no path that reaches `apps/register` or `apps/create`. The compile-
 * time guarantee is structural: this module imports nothing from
 * `@moltzap/app-sdk`. The runtime guarantee is verified by
 * `test/moltzap-worker-channel.test.ts`.
 *
 * **Direction enforcement.** Under the channel-plugin model, the only
 * outbound is the MCP `reply` tool, which targets the inbound chat_id
 * (the originating conversationId; see
 * `~/moltzap/packages/claude-code-channel/dist/routing.d.ts`). zapbot's
 * old client-side `sendableKeysForRole` gate dissolves — there is no
 * "send on key" surface from worker code. Direction is enforced by
 * which conversation the publisher chose at admission time. See design
 * doc §5.5 for the implication on the directional 5-key map.
 */

import { Effect } from "effect";
import { bootClaudeCodeChannel } from "@moltzap/claude-code-channel";
import type {
  BootError,
  GateInbound,
  Handle as ChannelHandle,
} from "@moltzap/claude-code-channel";
import type { WsClientLogger } from "@moltzap/client";
import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { SessionRole } from "./session-role.ts";
import { decodeSessionRole } from "./session-role.ts";

// ── Env decode ──────────────────────────────────────────────────────

/**
 * Decoded shape of the spawn env that the bridge writes for every
 * worker process. The bridge writes these via `buildMoltzapSpawnEnv`
 * (already in zapbot HEAD); this module decodes them.
 */
export interface WorkerChannelEnv {
  readonly serverUrl: string;
  readonly agentKey: string;
  /**
   * Bridge's MoltZap agentId. Optional: used only for log tagging and
   * telemetry. Not load-bearing for connect; the worker's WS does not
   * reference the bridge directly.
   */
  readonly bridgeAgentId: string | null;
  /** Closed-enum role for log tagging and metadata-file emission. */
  readonly role: SessionRole;
}

export type WorkerChannelEnvDecodeError =
  | { readonly _tag: "WorkerChannelMissingServerUrl"; readonly reason: string }
  | { readonly _tag: "WorkerChannelMissingAgentKey"; readonly reason: string }
  | { readonly _tag: "WorkerChannelInvalidRole"; readonly raw: string };

function trim(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * Decode the worker's spawn env into a typed `WorkerChannelEnv`.
 * Principle 2 boundary: every value crossing the env boundary is
 * validated here; downstream code consumes the typed shape.
 *
 * Env var mapping (stable from `ao-spawn-with-moltzap.ts`):
 *   `MOLTZAP_SERVER_URL` — required.
 *   `MOLTZAP_AGENT_KEY` — required (worker's minted per-spawn agentKey).
 *     Falls back to `MOLTZAP_API_KEY` for transitional deployments that
 *     still emit the v1 name.
 *   `MOLTZAP_BRIDGE_AGENT_ID` — optional, telemetry only.
 *   `AO_CALLER_TYPE` — required. One of `architect | implementer |
 *     reviewer | orchestrator`.
 */
export function loadWorkerChannelEnv(
  env: Record<string, string | undefined>,
): Result<WorkerChannelEnv, WorkerChannelEnvDecodeError> {
  const serverUrl = trim(env.MOLTZAP_SERVER_URL);
  if (serverUrl === null) {
    return err({
      _tag: "WorkerChannelMissingServerUrl",
      reason: "MOLTZAP_SERVER_URL must be set for worker channel boot",
    });
  }

  const agentKey = trim(env.MOLTZAP_AGENT_KEY) ?? trim(env.MOLTZAP_API_KEY);
  if (agentKey === null) {
    return err({
      _tag: "WorkerChannelMissingAgentKey",
      reason:
        "MOLTZAP_AGENT_KEY (or legacy MOLTZAP_API_KEY) must be set — provisioned by the bridge per-spawn",
    });
  }

  // AO_CALLER_TYPE emits "orchestrator" for the bridge and the legacy
  // "agent" sentinel for generic worker launches (bin/ao-spawn-with-moltzap.ts
  // resume path). An explicit MOLTZAP_WORKER_ROLE overrides; otherwise
  // "agent" maps to "implementer" — a safe default for log tagging since
  // the channel-plugin itself does not branch on role (rev 4 §5.5 — role
  // is a publisher-intent label, not a server-enforced filter).
  const explicitRole = trim(env.MOLTZAP_WORKER_ROLE);
  const rawAoCaller = trim(env.AO_CALLER_TYPE) ?? "";
  const rawRole =
    explicitRole ??
    (rawAoCaller === "agent" ? "implementer" : rawAoCaller);
  const decoded = decodeSessionRole(rawRole);
  if (decoded._tag === "Err") {
    return err({
      _tag: "WorkerChannelInvalidRole",
      raw: rawRole,
    });
  }

  return ok({
    serverUrl,
    agentKey,
    bridgeAgentId: trim(env.MOLTZAP_BRIDGE_AGENT_ID),
    role: decoded.value,
  });
}

// ── Boot config + errors ────────────────────────────────────────────

export interface WorkerChannelBootConfig {
  readonly serverUrl: string;
  readonly agentKey: string;
  readonly logger: WsClientLogger;
  readonly role: SessionRole;
  /**
   * Optional inbound predicate forwarded to the channel package. v1
   * default is null (no gate): server-side `participantFilter` +
   * bridge-side `apps/create({invitedAgentIds})` already constrain who
   * can deliver to this agent. Carried so a future consumer can re-add
   * an additional zapbot-side filter without contract negotiation.
   */
  readonly gateInbound?: GateInbound;
}

/**
 * Boot errors. Wraps the channel package's `BootError` (see
 * `~/moltzap/packages/claude-code-channel/dist/errors.d.ts`) and adds
 * tags for the env-decode boundary owned by this module.
 *
 * Principle 4: every consumer of `WorkerChannelBootError` ends switches
 * with `absurd(error)`.
 */
export type WorkerChannelBootError =
  | { readonly _tag: "WorkerChannelAlreadyBooted" }
  | {
      readonly _tag: "WorkerChannelBootFailed";
      readonly cause: BootError;
    };

// ── Public handle ───────────────────────────────────────────────────

/**
 * Lifecycle handle returned by `bootWorkerChannel`.
 *
 * Notably absent: any "send on key" surface. The channel package owns
 * outbound; zapbot worker code does not author messages directly.
 * Replies originate inside the MCP `reply` tool when Claude Code
 * invokes it; routing back to MoltZap is handled by the channel
 * package (see `routing.d.ts`).
 */
export interface WorkerChannelHandle {
  readonly role: SessionRole;
  /** Underlying channel-plugin handle. Exposed for test introspection only. */
  readonly channel: ChannelHandle;
  /** Idempotent teardown. Closes WS + MCP transport. */
  readonly stop: () => Effect.Effect<void>;
}

// Module-local singleton. Invariant: one worker channel per process.
let __workerChannelSingleton: WorkerChannelHandle | null = null;

/**
 * Boot a Claude-Code worker channel for this process. Singleton-
 * enforced (one channel per worker process).
 *
 * Internally calls `bootClaudeCodeChannel`. Returns an Effect so the
 * call site composes with the rest of zapbot's Effect-shaped boot.
 * The channel package's promise-returning entry is wrapped here.
 */
export function bootWorkerChannel(
  config: WorkerChannelBootConfig,
): Effect.Effect<WorkerChannelHandle, WorkerChannelBootError> {
  return Effect.gen(function* () {
    if (__workerChannelSingleton !== null) {
      return yield* Effect.fail<WorkerChannelBootError>({
        _tag: "WorkerChannelAlreadyBooted",
      });
    }

    const result = yield* Effect.promise(() =>
      bootClaudeCodeChannel({
        serverUrl: config.serverUrl,
        agentKey: config.agentKey,
        logger: config.logger,
        ...(config.gateInbound !== undefined
          ? { gateInbound: config.gateInbound }
          : {}),
      }),
    );

    if (result._tag === "Err") {
      return yield* Effect.fail<WorkerChannelBootError>({
        _tag: "WorkerChannelBootFailed",
        cause: result.error,
      });
    }

    const channel = result.value;
    const handle: WorkerChannelHandle = {
      role: config.role,
      channel,
      stop: () =>
        Effect.gen(function* () {
          yield* channel.stop();
          if (__workerChannelSingleton === handle) {
            __workerChannelSingleton = null;
          }
        }),
    };
    __workerChannelSingleton = handle;
    return handle;
  });
}

/**
 * Return the booted worker handle, or `null` if `bootWorkerChannel`
 * has not run.
 */
export function currentWorkerChannel(): WorkerChannelHandle | null {
  return __workerChannelSingleton;
}

/**
 * Tear down the worker channel. Idempotent. Called at process exit.
 * The bridge owns `apps/closeSession`; worker shutdown does NOT close
 * the session (initiator-privileged operation).
 */
export function shutdownWorkerChannel(): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const handle = __workerChannelSingleton;
    if (handle === null) return;
    yield* handle.stop();
    __workerChannelSingleton = null;
  });
}

// Test-only escape hatch.
export function __resetWorkerChannelForTests(): void {
  __workerChannelSingleton = null;
}
