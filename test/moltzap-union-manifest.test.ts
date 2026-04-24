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
