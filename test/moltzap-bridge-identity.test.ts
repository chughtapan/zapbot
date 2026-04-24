/**
 * Test stubs for src/moltzap/bridge-identity.ts.
 *
 * Anchors: sbd#199 acceptance item 7 (bridge identity per A+C(2));
 * replacement for the literal-string fallback at src/bridge.ts:801-803.
 */

import { describe, it } from "vitest";

describe("bridge-identity: env decode", () => {
  it.todo(
    "loadBridgeIdentityEnv returns BridgeIdentityMissingSecret when registration secret is unset",
  );
  it.todo(
    "loadBridgeIdentityEnv defaults displayName to 'zapbot-bridge' when env var is unset",
  );
  it.todo(
    "loadBridgeIdentityEnv returns BridgeIdentityInvalidEnv when displayName exceeds 128 chars",
  );
});

describe("bridge-identity: registerBridgeAgent", () => {
  it.todo(
    "registerBridgeAgent calls POST /api/v1/auth/register with the registration secret",
  );
  it.todo(
    "registerBridgeAgent returns BridgeRegistrationHttpFailed on non-2xx response",
  );
  it.todo(
    "registerBridgeAgent returns BridgeRegistrationDecodeFailed on malformed response body",
  );
  // Rev 3 §8.1 path (A): no persistence in v1. Every bridge boot mints a
  // fresh agentKey. The rev 1 / rev 2-base persistence stubs
  // (`persistencePath`, reuse-on-subsequent-boot, `BridgeRegistrationPersistFailed`)
  // are dissolved by construction. See rev 4 §8.1.
});

describe("bridge-identity: branded type", () => {
  it.todo(
    "BridgeAgentId is type-distinct from MoltzapSenderId (compile-time)",
  );
  it.todo(
    "bridgeAgentIdAsSenderId widens the brand to MoltzapSenderId for routing",
  );
});

describe("bridge-identity: literal-string fallback removal", () => {
  it.todo(
    "no source file references the literal 'zapbot-orchestrator' after this PR",
  );
  it.todo(
    "RosterManager constructor receives bridgeAgentId() not MOLTZAP_ORCHESTRATOR_SENDER_ID",
  );
});
