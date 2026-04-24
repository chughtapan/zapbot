import { describe, expect, it } from "vitest";
import {
  ALL_PEER_CHANNEL_KINDS,
  allowsRolePair,
  channelsForRole,
  decodeChannelKind,
  extendAllowlistForRole,
  type PeerChannelKind,
} from "../src/moltzap/role-topology.ts";
import {
  fromSenderIds,
  gateInbound,
} from "../src/moltzap/identity-allowlist.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
} from "../src/moltzap/types.ts";
import type { SessionRole } from "../src/moltzap/session-role.ts";

const ROLES: readonly SessionRole[] = [
  "orchestrator",
  "architect",
  "implementer",
  "reviewer",
];

describe("role-topology.allowsRolePair", () => {
  // Allowed table from architect plan §4.5.
  const allowedTable: ReadonlyArray<[PeerChannelKind, SessionRole, SessionRole]> = [
    ["orchestrator-to-worker", "orchestrator", "architect"],
    ["orchestrator-to-worker", "orchestrator", "implementer"],
    ["orchestrator-to-worker", "orchestrator", "reviewer"],
    ["worker-to-orchestrator", "architect", "orchestrator"],
    ["worker-to-orchestrator", "implementer", "orchestrator"],
    ["worker-to-orchestrator", "reviewer", "orchestrator"],
    ["architect-peer", "architect", "architect"],
    ["implementer-to-architect", "implementer", "architect"],
    ["review-to-author", "reviewer", "architect"],
    ["review-to-author", "reviewer", "implementer"],
  ];

  it.each(allowedTable)(
    "allows %s: %s -> %s",
    (kind, from, to) => {
      const res = allowsRolePair(kind, { from, to });
      expect(res._tag).toBe("Ok");
    },
  );

  it("rejects architect ↔ implementer direct", () => {
    const a = allowsRolePair("implementer-to-architect", {
      from: "architect",
      to: "implementer",
    });
    expect(a._tag).toBe("Err");
    const b = allowsRolePair("orchestrator-to-worker", {
      from: "architect",
      to: "implementer",
    });
    expect(b._tag).toBe("Err");
  });

  it("rejects reviewer ↔ reviewer sideways peer", () => {
    for (const kind of ALL_PEER_CHANNEL_KINDS) {
      const res = allowsRolePair(kind, {
        from: "reviewer",
        to: "reviewer",
      });
      expect(res._tag).toBe("Err");
    }
  });

  it("rejects implementer ↔ implementer sideways peer", () => {
    for (const kind of ALL_PEER_CHANNEL_KINDS) {
      const res = allowsRolePair(kind, {
        from: "implementer",
        to: "implementer",
      });
      expect(res._tag).toBe("Err");
    }
  });

  it("rejects orchestrator-to-orchestrator on any kind", () => {
    for (const kind of ALL_PEER_CHANNEL_KINDS) {
      const res = allowsRolePair(kind, {
        from: "orchestrator",
        to: "orchestrator",
      });
      expect(res._tag).toBe("Err");
    }
  });

  it("review-to-author with a non-reviewer sender is disallowed", () => {
    for (const from of ROLES) {
      if (from === "reviewer") continue;
      const res = allowsRolePair("review-to-author", {
        from,
        to: "architect",
      });
      expect(res._tag).toBe("Err");
    }
  });
});

describe("role-topology.channelsForRole", () => {
  it("returns the full channel set for orchestrator", () => {
    const s = channelsForRole("orchestrator");
    expect(s.has("orchestrator-to-worker")).toBe(true);
    expect(s.has("worker-to-orchestrator")).toBe(true);
  });

  it("architect can receive on architect-peer and review-to-author", () => {
    const s = channelsForRole("architect");
    expect(s.has("architect-peer")).toBe(true);
    expect(s.has("review-to-author")).toBe(true);
    expect(s.has("implementer-to-architect")).toBe(true);
  });

  it("reviewer's channel set excludes architect-peer", () => {
    const s = channelsForRole("reviewer");
    expect(s.has("architect-peer")).toBe(false);
    expect(s.has("implementer-to-architect")).toBe(false);
  });
});

describe("role-topology.decodeChannelKind", () => {
  it("decodes every known kind", () => {
    for (const kind of ALL_PEER_CHANNEL_KINDS) {
      const res = decodeChannelKind(kind);
      expect(res).toEqual({ _tag: "Ok", value: kind });
    }
  });

  it("rejects unknown kinds", () => {
    const res = decodeChannelKind("vote-tally");
    expect(res._tag).toBe("Err");
    if (res._tag !== "Err") return;
    expect(res.error._tag).toBe("ChannelKindUnknown");
  });
});

describe("role-topology.extendAllowlistForRole", () => {
  it("binds peer sender-ids into the allowlist for the given role", () => {
    const base = fromSenderIds([asMoltzapSenderId("base-o")]);
    const peers = new Map([
      ["orchestrator", [asMoltzapSenderId("peer-o")]],
      ["architect", [asMoltzapSenderId("peer-a1"), asMoltzapSenderId("peer-a2")]],
    ] as const);

    const extended = extendAllowlistForRole(base, "architect", peers);

    // Architect receives: orchestrator-to-worker (from orchestrator),
    // architect-peer (from architect). Implementer & reviewer follow-up
    // reach architect too.
    const makeEvent = (senderId: string) => ({
      messageId: asMoltzapMessageId("m"),
      conversationId: asMoltzapConversationId("c"),
      senderId: asMoltzapSenderId(senderId),
      bodyText: "hi",
      receivedAtMs: 0,
    });
    expect(gateInbound(extended, makeEvent("peer-o"))._tag).toBe("Ok");
    expect(gateInbound(extended, makeEvent("peer-a1"))._tag).toBe("Ok");
    expect(gateInbound(extended, makeEvent("peer-a2"))._tag).toBe("Ok");
    // Base allowlist entries are preserved.
    expect(gateInbound(extended, makeEvent("base-o"))._tag).toBe("Ok");
  });

  it("does not leak peers to a role that cannot receive from them", () => {
    const base = fromSenderIds([]);
    // reviewer cannot receive from architect directly (A ↔ R must go through
    // orchestrator), so architect peers should NOT be added.
    const peers = new Map([
      ["architect", [asMoltzapSenderId("peer-a")]],
    ] as const);
    const extended = extendAllowlistForRole(base, "reviewer", peers);
    const evt = {
      messageId: asMoltzapMessageId("m"),
      conversationId: asMoltzapConversationId("c"),
      senderId: asMoltzapSenderId("peer-a"),
      bodyText: "",
      receivedAtMs: 0,
    };
    expect(gateInbound(extended, evt)._tag).toBe("Err");
  });

  it("does not mutate the base allowlist", () => {
    const base = fromSenderIds([asMoltzapSenderId("base-o")]);
    const peers = new Map([
      ["orchestrator", [asMoltzapSenderId("peer-o")]],
    ] as const);
    extendAllowlistForRole(base, "architect", peers);
    // peer-o was not in the base — gate should still reject on `base`.
    const evt = {
      messageId: asMoltzapMessageId("m"),
      conversationId: asMoltzapConversationId("c"),
      senderId: asMoltzapSenderId("peer-o"),
      bodyText: "",
      receivedAtMs: 0,
    };
    expect(gateInbound(base, evt)._tag).toBe("Err");
  });
});
