import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ALL_PEER_MESSAGE_KINDS,
  classifyForOrchestrator,
  decodePeerMessage,
  encodePeerMessage,
  interpretWorkerComment,
  type PeerEndpoint,
  type PeerMessage,
  type PeerMessageKind,
} from "../src/orchestrator/peer-message.ts";
import { ALL_PEER_CHANNEL_KINDS } from "../src/moltzap/role-topology.ts";
import { asAoSessionName } from "../src/types.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";

function baseMessage(overrides: Partial<PeerMessage> = {}): PeerMessage {
  return {
    _tag: "PeerMessage",
    kind: "status-update",
    channel: "worker-to-orchestrator",
    from: {
      role: "architect",
      session: asAoSessionName("sess-a"),
      senderId: asMoltzapSenderId("sender-a"),
    },
    to: { role: "orchestrator", senderId: asMoltzapSenderId("sender-o") },
    body: "hello",
    artifactUrl: null,
    correlationId: "corr-1",
    sentAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe("peer-message.decodePeerMessage", () => {
  it("decodes a valid payload", () => {
    const msg = baseMessage();
    const raw = encodePeerMessage(msg);
    const res = decodePeerMessage(raw);
    expect(res._tag).toBe("Ok");
    if (res._tag !== "Ok") return;
    expect(res.value).toEqual(msg);
  });

  it("rejects non-JSON body with PeerMessageShapeInvalid", () => {
    const res = decodePeerMessage("not json {");
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PeerMessageShapeInvalid");
  });

  it("rejects non-object top level", () => {
    const res = decodePeerMessage(JSON.stringify([1, 2]));
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PeerMessageShapeInvalid");
  });

  it("rejects wrong _tag", () => {
    const res = decodePeerMessage(
      JSON.stringify({ ...baseMessage(), _tag: "NotPeerMessage" }),
    );
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PeerMessageShapeInvalid");
  });

  it("rejects unknown kind with PeerMessageKindUnknown", () => {
    const msg = baseMessage();
    const rawObj = JSON.parse(encodePeerMessage(msg)) as Record<string, unknown>;
    rawObj.kind = "vote-tally";
    const res = decodePeerMessage(JSON.stringify(rawObj));
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PeerMessageKindUnknown");
  });

  it("rejects unknown channel with PeerMessageChannelUnknown", () => {
    const msg = baseMessage();
    const rawObj = JSON.parse(encodePeerMessage(msg)) as Record<string, unknown>;
    rawObj.channel = "winner-declaration";
    const res = decodePeerMessage(JSON.stringify(rawObj));
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PeerMessageChannelUnknown");
  });

  it("rejects missing correlationId", () => {
    const msg = baseMessage();
    const rawObj = JSON.parse(encodePeerMessage(msg)) as Record<string, unknown>;
    delete rawObj.correlationId;
    const res = decodePeerMessage(JSON.stringify(rawObj));
    expect(res._tag).toBe("Err");
  });

  it("rejects endpoint with unknown role", () => {
    const msg = baseMessage();
    const rawObj = JSON.parse(encodePeerMessage(msg)) as Record<string, unknown>;
    (rawObj.from as Record<string, unknown>).role = "captain";
    const res = decodePeerMessage(JSON.stringify(rawObj));
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PeerMessageShapeInvalid");
  });
});

describe("peer-message.encodePeerMessage roundtrip", () => {
  it("decode ∘ encode = id", () => {
    fc.assert(
      fc.property(
        fc.record({
          kind: fc.constantFrom<PeerMessageKind>(...ALL_PEER_MESSAGE_KINDS),
          channel: fc.constantFrom(...ALL_PEER_CHANNEL_KINDS),
          body: fc.string({ minLength: 0, maxLength: 200 }),
          artifactUrl: fc.option(
            fc.webUrl(),
            { nil: null },
          ),
          correlationId: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
          sentAtMs: fc.integer({ min: 0, max: 2 ** 41 }),
        }),
        (overrides) => {
          const msg: PeerMessage = baseMessage(overrides);
          const raw = encodePeerMessage(msg);
          const decoded = decodePeerMessage(raw);
          expect(decoded._tag).toBe("Ok");
          if (decoded._tag !== "Ok") return;
          expect(decoded.value).toEqual(msg);
        },
      ),
    );
  });
});

describe("peer-message.interpretWorkerComment", () => {
  const source: PeerEndpoint = {
    role: "architect",
    session: asAoSessionName("sess-a"),
    senderId: asMoltzapSenderId("sender-a"),
  };

  it("accepts a message whose from matches the source", () => {
    const msg = baseMessage({ from: source });
    const raw = encodePeerMessage(msg);
    const res = interpretWorkerComment(raw, source);
    expect(res._tag).toBe("Ok");
  });

  it("rejects a spoofed sender-id (prompt injection posture)", () => {
    const msg = baseMessage({
      from: { ...source, senderId: asMoltzapSenderId("sender-evil") },
    });
    const raw = encodePeerMessage(msg);
    const res = interpretWorkerComment(raw, source);
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("PeerMessageShapeInvalid");
  });

  it("rejects a spoofed role", () => {
    const msg = baseMessage({
      from: { ...source, role: "reviewer" },
    });
    const raw = encodePeerMessage(msg);
    const res = interpretWorkerComment(raw, source);
    expect(res._tag).toBe("Err");
  });
});

describe("peer-message.classifyForOrchestrator", () => {
  it("artifact-published with URL → ConvergenceCandidate", () => {
    const msg = baseMessage({
      kind: "artifact-published",
      artifactUrl: "https://example.com/issues/1#comment-42",
    });
    const action = classifyForOrchestrator(msg);
    expect(action._tag).toBe("ConvergenceCandidate");
    if (action._tag !== "ConvergenceCandidate") return;
    expect(action.artifactUrl).toBe("https://example.com/issues/1#comment-42");
  });

  it("artifact-published without URL → StatusIngested (degenerate case)", () => {
    const msg = baseMessage({ kind: "artifact-published", artifactUrl: null });
    expect(classifyForOrchestrator(msg)._tag).toBe("StatusIngested");
  });

  it("status-update → StatusIngested", () => {
    expect(classifyForOrchestrator(baseMessage({ kind: "status-update" }))._tag).toBe(
      "StatusIngested",
    );
  });

  it("review-request → FollowUpDispatch", () => {
    const msg = baseMessage({ kind: "review-request" });
    const action = classifyForOrchestrator(msg);
    expect(action._tag).toBe("FollowUpDispatch");
    if (action._tag !== "FollowUpDispatch") return;
    expect(action.target).toEqual(msg.to);
  });

  it("architect-peer-ping → PeerCoordination", () => {
    expect(classifyForOrchestrator(baseMessage({ kind: "architect-peer-ping" }))._tag).toBe(
      "PeerCoordination",
    );
  });

  it("retire-notice → RetireNotice keyed by sender session", () => {
    const action = classifyForOrchestrator(baseMessage({ kind: "retire-notice" }));
    expect(action._tag).toBe("RetireNotice");
    if (action._tag !== "RetireNotice") return;
    expect(action.session).toBe(asAoSessionName("sess-a"));
  });

  it("Invariant 7: no convergence kind on the wire type", () => {
    // Attempt to decode a wire message tagged with a forbidden kind should
    // surface as PeerMessageKindUnknown, not ConvergenceCandidate.
    const forbidden = ["vote-tally", "winner-declaration", "elimination-signal"];
    for (const kind of forbidden) {
      const rawObj = {
        ...JSON.parse(encodePeerMessage(baseMessage())),
        kind,
      };
      const res = decodePeerMessage(JSON.stringify(rawObj));
      expect(res._tag).toBe("Err");
      if (res._tag !== "Err") continue;
      expect(res.error._tag).toBe("PeerMessageKindUnknown");
    }
  });
});
