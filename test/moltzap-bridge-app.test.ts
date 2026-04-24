/**
 * Test stubs for src/moltzap/bridge-app.ts.
 *
 * Anchors: sbd#199 acceptance item 7 (bridge identity boot sequence per
 * A+C(2)) and item 9 (moltzap#230 operational posture). All bodies
 * `it.todo` per architect skill rules — implement-staff fills them in
 * against the design doc.
 */

import { describe, it } from "vitest";

describe("bridge-app: boot sequence", () => {
  it.todo(
    "bootBridgeApp calls registerBridgeAgent then constructs MoltZapApp with the union manifest",
  );
  it.todo("bootBridgeApp is idempotent: second call returns BridgeAppAlreadyBooted");
  it.todo(
    "bootBridgeApp recovers a previously persisted agent key when ZAPBOT_MOLTZAP_BRIDGE_AGENT_KEY_PATH is set",
  );
  it.todo("bootBridgeApp surfaces BridgeAppRegistrationFailed on auth/register HTTP failure");
  it.todo("bootBridgeApp surfaces BridgeAppManifestInvalid when union manifest verification fails");
});

describe("bridge-app: bridgeAgentId surface", () => {
  it.todo("bridgeAgentId returns null before bootBridgeApp resolves");
  it.todo("bridgeAgentId returns the registered BridgeAgentId after boot");
  it.todo("RosterManager seeds its allowlist from bridgeAgentId, never the literal 'zapbot-orchestrator'");
});

describe("bridge-app: silence invariant", () => {
  it.todo("BridgeAppHandle does not expose send / sendOnKey / reply");
  it.todo("createBridgeSession returns BridgeSessionHandle without a send surface");
  it.todo(
    "during a full session lifecycle the bridge process issues zero messages/send RPCs",
  );
});

describe("bridge-app: SIGHUP reload policy", () => {
  it.todo("SIGHUP reload does not call shutdownBridgeApp");
  it.todo("SIGHUP reload preserves the live MoltZap WS connection");
  it.todo("SIGHUP reload preserves active sessions (no closeSession side-effect)");
});

describe("bridge-app: session lifecycle", () => {
  it.todo("createBridgeSession invites all roster senderIds via apps/create");
  it.todo("closeBridgeSession is idempotent");
  it.todo(
    "drainBridgeSessions closes every active session within timeoutMs and reports leaks",
  );
});

describe("bridge-app: moltzap#230 operational posture", () => {
  it.todo(
    "bridge SIGTERM drain attempts to close active sessions before exit (best-effort)",
  );
  it.todo(
    "bridge restart leaves any non-drained session in active state (accepted v1 limitation)",
  );
});
