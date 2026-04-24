/**
 * moltzap/bridge-identity — bridge-process MoltZap agent identity.
 *
 * Anchors: sbd#199 acceptance items 7 (bridge identity per A+C(2)) and
 * 8 (zapbot#336 resolution path b — single bridge-owned manifest).
 * Operator decision: https://github.com/chughtapan/safer-by-default/issues/197#issuecomment-4316611469
 *
 * Replaces the literal-string fallback at `src/bridge.ts:801-803`. The
 * bridge process auto-registers its own MoltZap agent at boot via
 * `POST /api/v1/auth/register`, then persists its assigned `agentKey` and
 * `senderId` for the lifetime of the process. `RosterManager` reads
 * `bridgeAgentId()` (from `bridge-app.ts`) instead of the
 * `MOLTZAP_ORCHESTRATOR_SENDER_ID` env var or the literal
 * `"zapbot-orchestrator"` fallback.
 *
 * Boot env contract:
 *   `ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME` — optional display name; defaults to
 *     `"zapbot-bridge"`.
 *   `ZAPBOT_MOLTZAP_BRIDGE_AGENT_KEY_PATH` — optional path to a persisted
 *     agent-key blob; if present and readable, the bridge reuses the
 *     agent across restarts. If absent, the bridge mints a fresh agent on
 *     each boot (acceptable for v1 — moltzap#230 leak class accepted).
 *   `ZAPBOT_MOLTZAP_REGISTRATION_SECRET` — REQUIRED for boot; sourced via
 *     `runtime.ts` `MoltzapRegistration.registrationSecret`.
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
 * Decode boot env into the static portion of `BridgeIdentity` (display
 * name + key path). The dynamic portion (`agentId`, `agentKey`) is
 * filled by `registerBridgeAgent` after `POST /api/v1/auth/register`
 * resolves.
 *
 * Principle 2 (boundary decode): env values are validated here; invariant
 * inside the type "BridgeIdentity is fully populated" holds for the rest
 * of the process.
 */
export function loadBridgeIdentityEnv(
  env: Record<string, string | undefined>,
): Result<
  { readonly displayName: string; readonly persistencePath: string | null },
  BridgeIdentityDecodeError
> {
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
    }
  | {
      readonly _tag: "BridgeRegistrationPersistFailed";
      readonly cause: string;
    };

export interface BridgeRegistrationInput {
  readonly serverUrl: string;
  readonly registrationSecret: string;
  readonly displayName: string;
  /** Optional path to persist the minted agent key blob. */
  readonly persistencePath: string | null;
}

/**
 * Mint (or reload) the bridge's MoltZap agent credentials. If
 * `persistencePath` resolves to a readable blob, decode and reuse;
 * otherwise call `POST /api/v1/auth/register` with the registration
 * secret, persist the response, and return the materialized identity.
 *
 * Implementation note: the body of this function is owned by
 * `implement-staff`. Architect names the error channel and the
 * persistence-vs-mint policy.
 */
export function registerBridgeAgent(
  input: BridgeRegistrationInput,
): Promise<Result<BridgeIdentity, BridgeRegistrationError>> {
  throw new Error("not implemented");
}
