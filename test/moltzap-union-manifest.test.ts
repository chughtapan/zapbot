/**
 * Test stubs for src/moltzap/union-manifest.ts.
 *
 * Anchors: sbd#199 acceptance items 4 (AppManifest shape) and 8
 * (zapbot#336 path b — single bridge-owned manifest).
 */

import { describe, it } from "vitest";

describe("union-manifest: shape", () => {
  it.todo(
    "buildUnionManifest declares every key in ALL_CONVERSATION_KEYS",
  );
  it.todo(
    "buildUnionManifest sets participantFilter='all' on every conversation block",
  );
  it.todo("buildUnionManifest carries appId === ZAPBOT_APP_ID");
  it.todo(
    "buildUnionManifest exposes empty required and optional permissions (OQ #2 default)",
  );
});

describe("union-manifest: verification", () => {
  it.todo(
    "verifyUnionManifest returns null when manifest declares all 5 keys",
  );
  it.todo(
    "verifyUnionManifest reports missing keys when one or more are absent",
  );
  it.todo(
    "verifyUnionManifest reports extra keys when manifest declares unknown keys",
  );
});

describe("union-manifest: §8.2 dead-key invariant (rev 4)", () => {
  // Rev 4 §8.2 resolution: 5 directional keys retained, but
  // `coord-worker-to-orch` is declared DEAD under reply-on-inbound —
  // no organic publisher exists in v1. The assertion below gates the
  // dead-key claim: if the repo ever gains an organic publisher on
  // this key (e.g. a worker-initiated push), the assertion fails and
  // §8.2 is re-opened.
  it.todo(
    "zero source files under src/ and bin/ publish on 'coord-worker-to-orch' (grep-time check)",
  );
});
