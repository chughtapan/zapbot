/**
 * Tests for src/moltzap/bridge-silence.ts.
 *
 * Anchors: sbd#199 acceptance item 7 ("Silence invariant at app layer:
 * bridge does NOT author messages in role-pair conversations").
 *
 * Rev 2 correction: `tagWorker` / `requireWorker` / worker-tag branch
 * removed when workers moved to `@moltzap/claude-code-channel`. Only
 * the bridge-tag branch survives; worker identity is owned by the
 * channel-plugin, not the app-sdk tag. See rev 4 §2.5.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagBridge } from "../src/moltzap/bridge-silence.ts";
import {
  asBridgeAgentId,
  type BridgeAgentId,
} from "../src/moltzap/bridge-identity.ts";
import type { BridgeAppHandle } from "../src/moltzap/bridge-app.ts";

describe("bridge-silence: type discriminator", () => {
  it("tagBridge returns a handle with __tag === 'bridge'", () => {
    const agentId: BridgeAgentId = asBridgeAgentId("bridge-abc");
    const baseHandle: BridgeAppHandle = {
      agentId,
      displayName: "zapbot-bridge",
      onBridgeMessage: () => null,
      listActiveSessions: () => [],
    };
    const tagged = tagBridge(baseHandle);
    expect(tagged.__tag).toBe("bridge");
    expect(tagged.agentId).toBe(agentId);
    expect(tagged.displayName).toBe("zapbot-bridge");
  });

  it("tagged handle is frozen — consumers cannot defeat the brand at runtime", () => {
    const agentId: BridgeAgentId = asBridgeAgentId("bridge-abc");
    const tagged = tagBridge({
      agentId,
      displayName: "zapbot-bridge",
      onBridgeMessage: () => null,
      listActiveSessions: () => [],
    });
    expect(Object.isFrozen(tagged)).toBe(true);
  });
});

describe("bridge-silence: structural absence (grep-time)", () => {
  it("src/moltzap/bridge-app.ts exports no send/sendOnKey/reply surface", () => {
    const text = readFileSync(
      join(__dirname, "..", "src", "moltzap", "bridge-app.ts"),
      "utf8",
    );
    // Reject any `export` line that names a send-shaped symbol. We use
    // a tight regex so doc-comments mentioning "send" do not false-positive.
    const offenders = text.match(
      /^export (?:function|const|interface|type)\s+(send\w*|sendOnKey|sendTo|reply\w*)\b/gm,
    );
    expect(offenders).toBeNull();
  });
});
