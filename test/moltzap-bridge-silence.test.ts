/**
 * Test stubs for src/moltzap/bridge-silence.ts and the integration-level
 * silence assertion.
 *
 * Anchors: sbd#199 acceptance item 7 ("Silence invariant at app layer:
 * bridge does NOT author messages in role-pair conversations").
 */

import { describe, it } from "vitest";

describe("bridge-silence: type discriminator", () => {
  // Rev 2 correction: `tagWorker` / `requireWorker` / worker-tag branch
  // removed when workers moved to `@moltzap/claude-code-channel`. Only
  // the bridge-tag branch survives; worker identity is owned by the
  // channel-plugin, not the app-sdk tag. See rev 4 §2.5.
  it.todo("tagBridge returns a handle with __tag === 'bridge'");
});

describe("bridge-silence: integration-level invariant", () => {
  it.todo(
    "during a 2-member roster session, the bridge process issues zero messages/send RPCs",
  );
  it.todo(
    "during a 2-member roster session, the bridge process issues zero apps/reply RPCs",
  );
  it.todo(
    "during a 2-member roster session, the bridge issues exactly one apps/create and one apps/closeSession",
  );
});
