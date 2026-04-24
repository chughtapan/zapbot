import { describe, expect, it } from "vitest";
import {
  ALL_CONVERSATION_KEYS,
  decodeConversationKey,
  getRolePairBindings,
  receivableKeysForRole,
  sendableKeysForRole,
  type ConversationKey,
} from "../src/moltzap/conversation-keys.ts";
import {
  ALL_SESSION_ROLES,
  type SessionRole,
} from "../src/moltzap/session-role.ts";

describe("conversation-keys — key enumeration", () => {
  it("declares the 5 keys named in spec rev 2 §5", () => {
    expect([...ALL_CONVERSATION_KEYS].sort()).toEqual(
      [
        "coord-architect-peer",
        "coord-implementer-to-architect",
        "coord-orch-to-worker",
        "coord-review-to-author",
        "coord-worker-to-orch",
      ].sort(),
    );
  });

  it("every binding references an enumerated key exactly once", () => {
    const bindings = getRolePairBindings();
    const keys = bindings.map((b) => b.key).sort();
    expect(keys).toEqual([...ALL_CONVERSATION_KEYS].sort());
  });
});

describe("conversation-keys — decode boundary", () => {
  it("accepts every enumerated key", () => {
    for (const key of ALL_CONVERSATION_KEYS) {
      expect(decodeConversationKey(key)).toBe(key);
    }
  });

  it("rejects unknown strings with a tagged error", () => {
    const result = decodeConversationKey("coord-bogus");
    expect(result).toEqual({
      _tag: "UnknownConversationKey",
      raw: "coord-bogus",
    });
  });

  it("rejects non-string input", () => {
    // Boundary: wire values may be untyped JSON.
    const result = decodeConversationKey(42 as unknown as string);
    expect(result).toEqual({
      _tag: "UnknownConversationKey",
      raw: "42",
    });
  });
});

describe("conversation-keys — role-pair directionality (Invariant 6)", () => {
  it("orchestrator sends on orch-to-worker only", () => {
    expect([...sendableKeysForRole("orchestrator")].sort()).toEqual(
      ["coord-orch-to-worker"],
    );
  });

  it("orchestrator receives on worker-to-orch only", () => {
    expect([...receivableKeysForRole("orchestrator")].sort()).toEqual(
      ["coord-worker-to-orch"],
    );
  });

  it("architect sends on architect-peer and worker-to-orch", () => {
    expect([...sendableKeysForRole("architect")].sort()).toEqual(
      ["coord-architect-peer", "coord-worker-to-orch"].sort(),
    );
  });

  it("architect receives on every key that targets architects", () => {
    expect([...receivableKeysForRole("architect")].sort()).toEqual(
      [
        "coord-architect-peer",
        "coord-implementer-to-architect",
        "coord-orch-to-worker",
        "coord-review-to-author",
      ].sort(),
    );
  });

  it("implementer sends on implementer-to-architect and worker-to-orch", () => {
    expect([...sendableKeysForRole("implementer")].sort()).toEqual(
      ["coord-implementer-to-architect", "coord-worker-to-orch"].sort(),
    );
  });

  it("implementer receives on orch-to-worker and review-to-author", () => {
    expect([...receivableKeysForRole("implementer")].sort()).toEqual(
      ["coord-orch-to-worker", "coord-review-to-author"].sort(),
    );
  });

  it("reviewer sends on review-to-author and worker-to-orch", () => {
    expect([...sendableKeysForRole("reviewer")].sort()).toEqual(
      ["coord-review-to-author", "coord-worker-to-orch"].sort(),
    );
  });

  it("reviewer receives on orch-to-worker only", () => {
    expect([...receivableKeysForRole("reviewer")].sort()).toEqual(
      ["coord-orch-to-worker"],
    );
  });
});

describe("conversation-keys — role coverage exhaustiveness", () => {
  it("every role has a non-empty send-or-receive set", () => {
    // Principle 4 tie: no role is silently excluded from the topology.
    for (const role of ALL_SESSION_ROLES) {
      const send = sendableKeysForRole(role);
      const recv = receivableKeysForRole(role);
      expect(send.size + recv.size).toBeGreaterThan(0);
    }
  });

  it("no key has an empty senders set", () => {
    for (const b of getRolePairBindings()) {
      expect(b.senders.size).toBeGreaterThan(0);
      expect(b.receivers.size).toBeGreaterThan(0);
    }
  });

  it("receivers and senders only contain valid SessionRole values", () => {
    const roleSet = new Set<SessionRole>(ALL_SESSION_ROLES);
    for (const b of getRolePairBindings()) {
      for (const r of b.senders) expect(roleSet.has(r)).toBe(true);
      for (const r of b.receivers) expect(roleSet.has(r)).toBe(true);
    }
  });
});

describe("conversation-keys — type narrowing", () => {
  it("ALL_CONVERSATION_KEYS is assignable to ConversationKey[]", () => {
    // Smoke test — the compiler already enforces this, but pin it.
    const typed: readonly ConversationKey[] = ALL_CONVERSATION_KEYS;
    expect(typed.length).toBe(5);
  });
});
