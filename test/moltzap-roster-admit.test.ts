import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  admitLateJoiner,
  conversationsToAdmitForRole,
} from "../src/moltzap/roster-admit.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";

// Architect DESIGN §7 concrete late-joiner sets, derived from
// sendableKeysForRole ∪ receivableKeysForRole.
describe("roster-admit — conversationsToAdmitForRole (Invariant 11)", () => {
  it("architect joins all 5 conversations", () => {
    expect([...conversationsToAdmitForRole("architect")].sort()).toEqual(
      [
        "coord-architect-peer",
        "coord-implementer-to-architect",
        "coord-orch-to-worker",
        "coord-review-to-author",
        "coord-worker-to-orch",
      ].sort(),
    );
  });

  it("implementer joins 4 conversations (no architect-peer)", () => {
    expect([...conversationsToAdmitForRole("implementer")].sort()).toEqual(
      [
        "coord-implementer-to-architect",
        "coord-orch-to-worker",
        "coord-review-to-author",
        "coord-worker-to-orch",
      ].sort(),
    );
  });

  it("reviewer joins 3 conversations", () => {
    expect([...conversationsToAdmitForRole("reviewer")].sort()).toEqual(
      [
        "coord-orch-to-worker",
        "coord-review-to-author",
        "coord-worker-to-orch",
      ].sort(),
    );
  });
});

// Fake `bridgeApp` + `session` so the Effect reduction is exercised
// without real WS. Principle 2 fence: these fakes satisfy the MoltZapApp
// / AppSessionHandle shapes the roster-admit module calls on.
function fakeBridgeApp(
  rpc: (params: unknown) => Effect.Effect<unknown, unknown, never>,
): Parameters<typeof admitLateJoiner>[0]["bridgeApp"] {
  return {
    client: { sendRpc: (_method: string, params: unknown) => rpc(params) },
  } as unknown as Parameters<typeof admitLateJoiner>[0]["bridgeApp"];
}

function fakeSession(
  conversations: Record<string, string>,
): Parameters<typeof admitLateJoiner>[0]["session"] {
  return {
    id: "s1",
    appId: "zapbot-ws2",
    status: "active",
    conversations,
    isActive: true,
    conversationId: (k: string) => {
      const id = conversations[k];
      if (id === undefined) throw new Error(`no conv for ${k}`);
      return id;
    },
  } as unknown as Parameters<typeof admitLateJoiner>[0]["session"];
}

describe("roster-admit — admitLateJoiner happy path", () => {
  it("calls addParticipant once per conversation and returns admittedTo list", async () => {
    const calls: unknown[] = [];
    const rpc = (params: unknown) => {
      calls.push(params);
      return Effect.succeed({ ok: true });
    };
    const allKeys: Record<string, string> = {
      "coord-orch-to-worker": "c-a",
      "coord-worker-to-orch": "c-b",
      "coord-architect-peer": "c-c",
      "coord-implementer-to-architect": "c-d",
      "coord-review-to-author": "c-e",
    };
    const result = await Effect.runPromise(
      admitLateJoiner({
        joinerSenderId: asMoltzapSenderId("late-impl"),
        joinerRole: "implementer",
        bridgeApp: fakeBridgeApp(rpc),
        session: fakeSession(allKeys),
      }),
    );
    expect(result.admittedAtSessionLevel).toBe(false);
    expect(result.admittedTo).toHaveLength(4);
    expect(calls).toHaveLength(4);
  });
});

describe("roster-admit — admitLateJoiner error paths", () => {
  it("returns NotInitiator when isInitiator is false", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        admitLateJoiner({
          joinerSenderId: asMoltzapSenderId("joiner"),
          joinerRole: "reviewer",
          bridgeApp: fakeBridgeApp(() => Effect.succeed(null)),
          session: fakeSession({}),
          isInitiator: false,
        }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({ _tag: "NotInitiator" });
    }
  });

  it("returns LateJoinerSessionLevelUnavailable when requireSessionLevel is set", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        admitLateJoiner({
          joinerSenderId: asMoltzapSenderId("joiner"),
          joinerRole: "reviewer",
          bridgeApp: fakeBridgeApp(() => Effect.succeed(null)),
          session: fakeSession({}),
          requireSessionLevel: true,
        }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "LateJoinerSessionLevelUnavailable",
        upstreamIssue: "https://github.com/chughtapan/moltzap/issues/206",
      });
    }
  });

  it("returns KeyNotInSession when a required key is missing", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        admitLateJoiner({
          joinerSenderId: asMoltzapSenderId("joiner"),
          joinerRole: "reviewer",
          bridgeApp: fakeBridgeApp(() => Effect.succeed(null)),
          session: fakeSession({
            // reviewer needs 3 keys; this omits coord-worker-to-orch
            "coord-orch-to-worker": "c-a",
            "coord-review-to-author": "c-e",
          }),
        }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "KeyNotInSession",
        key: "coord-worker-to-orch",
      });
    }
  });

  it("returns AddParticipantRpcFailed (tagged) on RPC error", async () => {
    const rpc = () => Effect.fail(new Error("server 500"));
    const result = await Effect.runPromise(
      Effect.either(
        admitLateJoiner({
          joinerSenderId: asMoltzapSenderId("joiner"),
          joinerRole: "reviewer",
          bridgeApp: fakeBridgeApp(rpc),
          session: fakeSession({
            "coord-orch-to-worker": "c-a",
            "coord-worker-to-orch": "c-b",
            "coord-review-to-author": "c-e",
          }),
        }),
      ),
    );
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "AddParticipantRpcFailed",
        cause: "server 500",
      });
    }
  });
});
