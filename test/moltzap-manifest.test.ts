import { describe, expect, it } from "vitest";
import {
  ALL_CONVERSATION_KEYS,
} from "../src/moltzap/conversation-keys.ts";
import {
  buildOrchestratorManifest,
  buildWorkerManifest,
  conversationBlock,
  expectedKeysForRole,
  loadAppIdentity,
  verifyManifestKeys,
  ZAPBOT_APP_ID,
} from "../src/moltzap/manifest.ts";

const OK_ENV = {
  ZAPBOT_MOLTZAP_APP_DISPLAY_NAME: "zapbot-test",
  ZAPBOT_MOLTZAP_APP_DESCRIPTION: "test description",
};

describe("manifest — identity decode (Principle 2 boundary)", () => {
  it("decodes a valid env into an AppIdentity", () => {
    const result = loadAppIdentity(OK_ENV);
    expect(result).toEqual({
      appId: ZAPBOT_APP_ID,
      displayName: "zapbot-test",
      description: "test description",
    });
  });

  it("falls back to canned defaults when env is empty", () => {
    const result = loadAppIdentity({});
    expect(result).toEqual({
      appId: ZAPBOT_APP_ID,
      displayName: "zapbot",
      description: "zapbot multi-agent coordination (WS2 MVP)",
    });
  });

  it("returns a typed error for overlong display name", () => {
    const longName = "a".repeat(200);
    const result = loadAppIdentity({
      ZAPBOT_MOLTZAP_APP_DISPLAY_NAME: longName,
    });
    expect(result).toMatchObject({
      _tag: "AppIdentityDecodeError",
    });
  });
});

describe("manifest — role-scoped builders (OQ #4 resolution)", () => {
  const identity = loadAppIdentity(OK_ENV) as {
    readonly appId: typeof ZAPBOT_APP_ID;
    readonly displayName: string;
    readonly description: string;
  };

  it("orchestrator manifest declares all 5 keys with participantFilter: all", () => {
    const m = buildOrchestratorManifest(identity);
    expect(m.appId).toBe(ZAPBOT_APP_ID);
    expect(m.conversations?.length).toBe(5);
    for (const conv of m.conversations ?? []) {
      expect(conv.participantFilter).toBe("all");
    }
    expect(
      new Set((m.conversations ?? []).map((c) => c.key)),
    ).toEqual(new Set(ALL_CONVERSATION_KEYS));
  });

  it("architect manifest declares all 5 keys (architect participates in all)", () => {
    const m = buildWorkerManifest(identity, "architect");
    const keys = new Set((m.conversations ?? []).map((c) => c.key));
    expect(keys).toEqual(new Set(ALL_CONVERSATION_KEYS));
  });

  it("implementer manifest declares 4 keys (no architect-peer)", () => {
    const m = buildWorkerManifest(identity, "implementer");
    const keys = new Set((m.conversations ?? []).map((c) => c.key));
    expect(keys).toEqual(
      new Set([
        "coord-orch-to-worker",
        "coord-worker-to-orch",
        "coord-implementer-to-architect",
        "coord-review-to-author",
      ]),
    );
  });

  it("reviewer manifest declares 3 keys", () => {
    const m = buildWorkerManifest(identity, "reviewer");
    const keys = new Set((m.conversations ?? []).map((c) => c.key));
    expect(keys).toEqual(
      new Set([
        "coord-orch-to-worker",
        "coord-worker-to-orch",
        "coord-review-to-author",
      ]),
    );
  });

  it("appId is identical across all role manifests", () => {
    const orch = buildOrchestratorManifest(identity);
    const arch = buildWorkerManifest(identity, "architect");
    const impl = buildWorkerManifest(identity, "implementer");
    const rev = buildWorkerManifest(identity, "reviewer");
    expect(orch.appId).toBe(ZAPBOT_APP_ID);
    expect(arch.appId).toBe(ZAPBOT_APP_ID);
    expect(impl.appId).toBe(ZAPBOT_APP_ID);
    expect(rev.appId).toBe(ZAPBOT_APP_ID);
  });

  it("every manifest uses only participantFilter: all | initiator (Invariant 5)", () => {
    const identity2 = loadAppIdentity({}) as {
      readonly appId: typeof ZAPBOT_APP_ID;
      readonly displayName: string;
      readonly description: string;
    };
    const manifests = [
      buildOrchestratorManifest(identity2),
      buildWorkerManifest(identity2, "architect"),
      buildWorkerManifest(identity2, "implementer"),
      buildWorkerManifest(identity2, "reviewer"),
    ];
    for (const m of manifests) {
      for (const conv of m.conversations ?? []) {
        expect(
          conv.participantFilter === "all" ||
            conv.participantFilter === "initiator",
        ).toBe(true);
      }
    }
  });
});

describe("manifest — verifyManifestKeys (Invariant 2 gate)", () => {
  const identity = loadAppIdentity(OK_ENV) as {
    readonly appId: typeof ZAPBOT_APP_ID;
    readonly displayName: string;
    readonly description: string;
  };

  it("returns null on an exact match", () => {
    const m = buildOrchestratorManifest(identity);
    expect(
      verifyManifestKeys(m, expectedKeysForRole("orchestrator")),
    ).toBeNull();
  });

  it("returns ManifestKeyMismatch when manifest declares extra keys", () => {
    const m = buildOrchestratorManifest(identity);
    const result = verifyManifestKeys(m, ["coord-orch-to-worker"]);
    expect(result).toMatchObject({ _tag: "ManifestKeyMismatch" });
  });

  it("returns ManifestKeyMismatch when manifest declares fewer keys", () => {
    const m = buildWorkerManifest(identity, "reviewer");
    const result = verifyManifestKeys(m, [...ALL_CONVERSATION_KEYS]);
    expect(result).toMatchObject({ _tag: "ManifestKeyMismatch" });
  });
});

describe("manifest — conversationBlock", () => {
  it("builds a typed conversation block", () => {
    const block = conversationBlock("coord-orch-to-worker", "all");
    expect(block.key).toBe("coord-orch-to-worker");
    expect(block.participantFilter).toBe("all");
  });
});
