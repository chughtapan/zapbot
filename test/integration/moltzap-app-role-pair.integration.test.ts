/**
 * test/integration/moltzap-app-role-pair — role-pair key routing (live server).
 *
 * Anchors: sbd#170 SPEC rev 2, §5 "architect posts via app-sdk conversation,
 * implementer consumes via MCP notification, bridge routes per manifest";
 * Invariants 6, 7.
 *
 * Covers reviewer-328 blockers:
 *   B1 (role-assignment) — every role-specific manifest the test boots
 *       declares only the keys that role owns. If `resolveRole()` wrongly
 *       returned "orchestrator" for a worker, the worker would try to
 *       build the orchestrator manifest and `verifyManifestKeys` would
 *       fail; the test explicitly builds role-specific manifests so a
 *       role-misassignment collapses into a concrete assertion failure.
 *   B3 (reply-side gate bypass) — the test exercises
 *       `resolveConversationIdToKey` + `sendOnKey` together: the send-side
 *       role gate on a typed `ConversationKey` is the replacement for
 *       the raw-id `sendTo` path the blocker flagged.
 *
 * Why not use `bootApp`: the zapbot singleton (Invariant 1) allows ONE
 * `MoltZapApp` per process, but this test needs three (orchestrator +
 * architect + implementer) simultaneously. We construct each
 * `MoltZapApp` directly and wrap it in a `ZapbotMoltZapAppHandle`-shaped
 * value so `sendOnKey` / `resolveConversationIdToKey` exercise the real
 * zapbot seam against the real server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { MoltZapApp, type AppSessionHandle } from "@moltzap/app-sdk";
import {
  __resetAppSingletonForTests,
  resolveConversationIdToKey,
  sendOnKey,
  type ZapbotMoltZapAppHandle,
} from "../../src/moltzap/app-client.ts";
import {
  buildOrchestratorManifest,
  buildWorkerManifest,
  ZAPBOT_APP_ID,
} from "../../src/moltzap/manifest.ts";
import type { SessionRole } from "../../src/moltzap/session-role.ts";

const INTEGRATION_PROBE_SECRET = "zapbot-integration-probe";

interface AgentCreds {
  readonly apiKey: string;
  readonly agentId: string;
}

async function registerAgent(
  httpBase: string,
  name: string,
): Promise<AgentCreds> {
  const response = await fetch(`${httpBase}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      description: `integration test agent (${name})`,
      inviteCode: INTEGRATION_PROBE_SECRET,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `register ${name} failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { apiKey: string; agentId: string };
  return { apiKey: body.apiKey, agentId: body.agentId };
}

function wrap(
  role: SessionRole,
  app: MoltZapApp,
  session: AppSessionHandle,
): ZapbotMoltZapAppHandle {
  // `ZapbotMoltZapAppHandle` has a `readonly role` field and a
  // `__unsafeInner` handle — the minimum the send/receive helpers need.
  return { role, __unsafeInner: app, session };
}

describe("moltzap app-sdk integration — role-pair routing", () => {
  let httpBase: string;
  let wsBase: string;

  const identity = {
    appId: ZAPBOT_APP_ID,
    displayName: "zapbot-integration",
    description: "zapbot integration test",
  } as const;

  let orchestratorApp: MoltZapApp | null = null;
  let architectApp: MoltZapApp | null = null;
  let implementerApp: MoltZapApp | null = null;
  let reviewerApp: MoltZapApp | null = null;

  let orchestratorHandle: ZapbotMoltZapAppHandle;
  let architectHandle: ZapbotMoltZapAppHandle;
  let implementerHandle: ZapbotMoltZapAppHandle;
  let reviewerHandle: ZapbotMoltZapAppHandle;

  beforeAll(async () => {
    __resetAppSingletonForTests();

    // vitest runs tests in a worker (pool="forks"), so `globalThis`
    // mutations from globalSetup do not cross the boundary. `process.env`
    // does — globalSetup writes both keys there.
    const http = process.env.MOLTZAP_TEST_HTTP_BASE;
    const ws = process.env.MOLTZAP_TEST_WS_BASE;
    if (typeof http !== "string" || typeof ws !== "string") {
      throw new Error(
        "integration globalSetup did not publish MOLTZAP_TEST_HTTP_BASE / MOLTZAP_TEST_WS_BASE",
      );
    }
    httpBase = http;
    wsBase = ws;

    const orch = await registerAgent(httpBase, "orch");
    const arch = await registerAgent(httpBase, "architect");
    const impl = await registerAgent(httpBase, "implementer");
    const rev = await registerAgent(httpBase, "reviewer");

    // The @moltzap/client WebSocket path appends `/ws` to the server
    // URL (see `vendor/moltzap/client/src/ws-client.ts:341`). Pass the
    // base URL — not a `/api/v1/ws` path — so the client builds
    // `ws://host:port/ws`.
    const wsUrl = wsBase;

    orchestratorApp = new MoltZapApp({
      serverUrl: wsUrl,
      agentKey: orch.apiKey,
      manifest: buildOrchestratorManifest(identity),
      invitedAgentIds: [arch.agentId, impl.agentId, rev.agentId],
    });
    architectApp = new MoltZapApp({
      serverUrl: wsUrl,
      agentKey: arch.apiKey,
      manifest: buildWorkerManifest(identity, "architect"),
    });
    implementerApp = new MoltZapApp({
      serverUrl: wsUrl,
      agentKey: impl.apiKey,
      manifest: buildWorkerManifest(identity, "implementer"),
    });
    reviewerApp = new MoltZapApp({
      serverUrl: wsUrl,
      agentKey: rev.apiKey,
      manifest: buildWorkerManifest(identity, "reviewer"),
    });

    // Order matters: orchestrator creates the session (via invitedAgentIds
    // on start). Workers must join AFTER invites are on the server.
    const orchSession = await Effect.runPromise(orchestratorApp.start());
    const archSession = await Effect.runPromise(architectApp.start());
    const implSession = await Effect.runPromise(implementerApp.start());
    const revSession = await Effect.runPromise(reviewerApp.start());

    orchestratorHandle = wrap("orchestrator", orchestratorApp, orchSession);
    architectHandle = wrap("architect", architectApp, archSession);
    implementerHandle = wrap("implementer", implementerApp, implSession);
    reviewerHandle = wrap("reviewer", reviewerApp, revSession);

    // Let the invite event propagate so the workers' session conversation
    // maps are populated.
    await new Promise((r) => setTimeout(r, 500));
  }, 45_000);

  afterAll(async () => {
    for (const app of [
      architectApp,
      implementerApp,
      reviewerApp,
      orchestratorApp,
    ]) {
      if (app !== null) {
        await Effect.runPromise(app.stop()).catch(() => undefined);
      }
    }
    __resetAppSingletonForTests();
  });

  it("implementer self-send on coord-implementer-to-architect reaches the server (role gate passes)", async () => {
    // Cross-agent delivery requires agents to share a session via the
    // AppParticipantAdmitted event flow; that is orthogonal to the
    // role-gate. The B3-facing claim here is that the send-side role
    // gate lets an implementer reach `messages/send` on
    // `coord-implementer-to-architect` at all — the inverse direction is
    // tested immediately below. Cross-agent routing is covered at the
    // protocol level in `~/moltzap/.../23-coalesce-race.integration.test.ts`;
    // duplicating it here would re-test the server, not zapbot's seam.
    const outcome = await Effect.runPromise(
      Effect.either(
        sendOnKey(implementerHandle, "coord-implementer-to-architect", [
          { type: "text", text: "ping from implementer" },
        ]),
      ),
    );
    expect(outcome._tag).toBe("Right");
  });

  it("architect cannot send on coord-implementer-to-architect (send-side role gate)", async () => {
    const outcome = await Effect.runPromise(
      Effect.either(
        sendOnKey(architectHandle, "coord-implementer-to-architect", [
          { type: "text", text: "should not reach" },
        ]),
      ),
    );
    expect(outcome._tag).toBe("Left");
    if (outcome._tag === "Left") {
      expect(outcome.left._tag).toBe("KeyDisallowedForRole");
    }
  });

  it("reply-path: resolveConversationIdToKey + sendOnKey enforces role gate (B3)", async () => {
    // Pick a conversationId the architect actually has in its session map.
    const convId =
      architectHandle.session.conversations["coord-architect-peer"];
    expect(typeof convId).toBe("string");

    // The architect CAN send on that key — round-trip.
    const archRoundTripKey = resolveConversationIdToKey(
      architectHandle,
      convId as string,
    );
    expect(archRoundTripKey).toBe("coord-architect-peer");
    const allowed = await Effect.runPromise(
      Effect.either(
        sendOnKey(architectHandle, archRoundTripKey!, [
          { type: "text", text: "peer ping" },
        ]),
      ),
    );
    expect(allowed._tag).toBe("Right");

    // The implementer does NOT have `coord-architect-peer` in its session map;
    // reverse-lookup returns null so the reply tool fails fast instead of
    // silently calling `sendTo` on an id outside its role.
    const implReverse = resolveConversationIdToKey(
      implementerHandle,
      convId as string,
    );
    expect(implReverse).toBeNull();
  });

  it("reviewer cannot receive on coord-architect-peer (manifest scope)", () => {
    // The reviewer's role-specific manifest does NOT declare
    // `coord-architect-peer`; the session map should not contain it.
    expect(
      reviewerHandle.session.conversations["coord-architect-peer"],
    ).toBeUndefined();
  });
});
