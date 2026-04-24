/**
 * moltzap/bridge-identity — bridge-process MoltZap agent identity.
 *
 * Anchors: sbd#199 acceptance items 7 (bridge identity per A+C(2)) and
 * 8 (zapbot#336 resolution path b — single bridge-owned manifest).
 * Operator decision: https://github.com/chughtapan/safer-by-default/issues/197#issuecomment-4316611469
 *
 * Replaces the literal-string fallback at `src/bridge.ts:801-803`. The
 * bridge process auto-registers its own MoltZap agent at boot via
 * `POST /api/v1/auth/register`. `RosterManager` reads `bridgeAgentId()`
 * (from `bridge-app.ts`) instead of the `MOLTZAP_ORCHESTRATOR_SENDER_ID`
 * env var or the literal `"zapbot-orchestrator"` fallback.
 *
 * **Persistence policy (rev 2.1, codex P1 fold).** No persistence in v1.
 * The bridge mints a fresh agent on every boot. This:
 *   1. Eliminates the §8.1+§8.5 destructive interaction (a persisted
 *      agentKey under a rotated registrationSecret would silently
 *      authenticate against the old secret, deferring rotation
 *      indefinitely until manual `rm`).
 *   2. Accepts the moltzap#230 leak class already documented for v1
 *      (bridge restart leaks in-flight sessions; SIGTERM drain
 *      mitigates).
 *   3. Trades a stable `BridgeAgentId` across restarts for cleaner
 *      rotation semantics. Tooling that needs "the live bridge id" reads
 *      it from `bridgeAgentId()` after boot, not from a long-lived
 *      identifier across restarts.
 *
 * Boot env contract:
 *   `ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME` — optional display name; defaults
 *     to `"zapbot-bridge"`.
 *   `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` — REQUIRED for boot; decoded
 *     here so all env reads are owned by this module (codex P2 fold —
 *     boundary-decode consistency).
 *
 * Principle 1 (branded types): `BridgeAgentId` is distinct from
 * `MoltzapSenderId` because the bridge's senderId is privileged (session
 * initiator + closeSession authority) and must not be confused with a
 * worker-role senderId at type level.
 */

import type { Result } from "../types.ts";
import type { MoltzapSenderId } from "./types.ts";

// ── Branded identity ────────────────────────────────────────────────

/**
 * The bridge process's MoltZap senderId. Distinct brand from
 * `MoltzapSenderId` so the type system rejects passing a worker senderId
 * where a bridge id is required (e.g., `apps/closeSession` caller).
 */
export type BridgeAgentId = string & { readonly __brand: "BridgeAgentId" };

/**
 * Coercion helper. Boundary callers (auth/register response decoder) call
 * this once after schema validation; downstream code uses the brand.
 */
export function asBridgeAgentId(s: string): BridgeAgentId {
  throw new Error("not implemented");
}

/**
 * Lossy projection: the bridge id IS a valid MoltzapSenderId for routing
 * purposes (it appears as a participant on every conversation). Used by
 * the RosterManager when seeding the orchestrator-side allowlist that
 * was previously the literal `"zapbot-orchestrator"` fallback.
 */
export function bridgeAgentIdAsSenderId(id: BridgeAgentId): MoltzapSenderId {
  throw new Error("not implemented");
}

// ── Identity decoded from runtime ───────────────────────────────────

/**
 * The bridge's MoltZap credentials. The `agentKey` is privileged — any
 * holder can authenticate as the bridge and call `apps/closeSession`.
 * It is constructed once inside `registerBridgeAgent` and consumed
 * directly by `bridge-app.ts`'s `new MoltZapApp(...)`. **It MUST NOT be
 * exposed on `BridgeAppHandle` or any public surface beyond the boot
 * boundary** (codex P2 fold — credential-leak guard via API shape).
 */
export interface BridgeIdentity {
  readonly agentId: BridgeAgentId;
  readonly agentKey: string;
  readonly displayName: string;
}

export type BridgeIdentityDecodeError =
  | {
      readonly _tag: "BridgeIdentityMissingSecret";
      readonly reason: string;
    }
  | {
      readonly _tag: "BridgeIdentityInvalidEnv";
      readonly reason: string;
    };

/**
 * Decoded shape of the boot env owned by this module (codex P2 fold —
 * single boundary). Includes the registration secret so all env reads
 * happen here.
 */
export interface BridgeIdentityEnv {
  readonly displayName: string;
  readonly registrationSecret: string;
}

/**
 * Decode boot env into the static portion of bridge identity (display
 * name + registration secret). The dynamic portion (`agentId`,
 * `agentKey`) is filled by `registerBridgeAgent` after
 * `POST /api/v1/auth/register` resolves.
 *
 * Principle 2 (boundary decode): env values are validated here; invariant
 * inside the type holds for the rest of the process.
 */
export function loadBridgeIdentityEnv(
  env: Record<string, string | undefined>,
): Result<BridgeIdentityEnv, BridgeIdentityDecodeError> {
  throw new Error("not implemented");
}

// ── Registration RPC ────────────────────────────────────────────────

export type BridgeRegistrationError =
  | {
      readonly _tag: "BridgeRegistrationHttpFailed";
      readonly status: number;
      readonly body: string;
    }
  | {
      readonly _tag: "BridgeRegistrationDecodeFailed";
      readonly reason: string;
    };

export interface BridgeRegistrationInput {
  readonly serverUrl: string;
  readonly registrationSecret: string;
  readonly displayName: string;
}

/**
 * Mint the bridge's MoltZap agent credentials by calling
 * `POST /api/v1/auth/register` with the registration secret. Returns the
 * materialized identity. No persistence layer in v1 (rev 2.1) — every
 * bridge boot mints a fresh agent.
 *
 * Implementation note: the body of this function is owned by
 * `implement-staff`. Architect names the error channel.
 */
export function registerBridgeAgent(
  input: BridgeRegistrationInput,
): Promise<Result<BridgeIdentity, BridgeRegistrationError>> {
  throw new Error("not implemented");
}
