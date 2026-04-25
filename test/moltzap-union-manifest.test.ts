/**
 * Tests for src/moltzap/union-manifest.ts.
 *
 * Anchors: sbd#199 acceptance items 4 (AppManifest shape) and 8
 * (zapbot#336 path b — single bridge-owned manifest); rev 4 §8.2
 * dead-key invariant on `coord-worker-to-orch`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZAPBOT_APP_ID } from "../src/moltzap/manifest.ts";
import {
  ALL_CONVERSATION_KEYS,
  type ConversationKey,
} from "../src/moltzap/conversation-keys.ts";
import {
  buildUnionManifest,
  verifyUnionManifest,
} from "../src/moltzap/union-manifest.ts";

const identity = {
  appId: ZAPBOT_APP_ID,
  displayName: "zapbot-bridge",
  description: "zapbot bridge process MoltZap app",
} as const;

describe("union-manifest: shape", () => {
  it("buildUnionManifest declares every key in ALL_CONVERSATION_KEYS", () => {
    const m = buildUnionManifest(identity);
    const declared = (m.conversations ?? []).map((c) => c.key).sort();
    expect(declared).toEqual([...ALL_CONVERSATION_KEYS].sort());
  });

  it("buildUnionManifest sets participantFilter='all' on every conversation block", () => {
    const m = buildUnionManifest(identity);
    for (const conv of m.conversations ?? []) {
      expect(conv.participantFilter).toBe("all");
    }
  });

  it("buildUnionManifest carries appId === ZAPBOT_APP_ID", () => {
    const m = buildUnionManifest(identity);
    expect(m.appId).toBe(ZAPBOT_APP_ID);
  });

  it("buildUnionManifest exposes empty required and optional permissions (OQ #2 default)", () => {
    const m = buildUnionManifest(identity);
    expect(m.permissions.required).toEqual([]);
    expect(m.permissions.optional).toEqual([]);
  });
});

describe("union-manifest: verification", () => {
  it("verifyUnionManifest returns null when manifest declares all 5 keys", () => {
    expect(verifyUnionManifest(buildUnionManifest(identity))).toBeNull();
  });

  it("verifyUnionManifest reports missing keys when one or more are absent", () => {
    const m = buildUnionManifest(identity);
    const partial = {
      ...m,
      conversations: (m.conversations ?? []).slice(0, 3),
    };
    const mismatch = verifyUnionManifest(partial);
    expect(mismatch).not.toBeNull();
    if (mismatch === null) return;
    expect(mismatch.missing.length).toBeGreaterThan(0);
    expect(mismatch.extra).toEqual([]);
  });

  it("verifyUnionManifest reports extra keys when manifest declares unknown keys", () => {
    const m = buildUnionManifest(identity);
    const extraManifest = {
      ...m,
      conversations: [
        ...(m.conversations ?? []),
        { key: "coord-unknown", name: "coord-unknown", participantFilter: "all" as const },
      ],
    };
    const mismatch = verifyUnionManifest(extraManifest);
    expect(mismatch).not.toBeNull();
    if (mismatch === null) return;
    expect(mismatch.missing).toEqual([]);
    expect(mismatch.extra).toEqual(["coord-unknown"]);
  });
});

describe("union-manifest: §8.2 dead-key invariant (rev 4)", () => {
  // Rev 4 §8.2 resolution: 5 directional keys retained, but
  // `coord-worker-to-orch` is declared DEAD under reply-on-inbound —
  // no organic publisher exists in v1. The assertion below gates the
  // dead-key claim: if the repo ever gains an organic publisher on
  // this key (e.g. a worker-initiated push), the assertion fails and
  // §8.2 is re-opened.
  it("zero source files under src/ and bin/ publish on 'coord-worker-to-orch' (grep-time check)", () => {
    const root = join(__dirname, "..");
    const scanDirs = ["src", "bin"];
    const offenders: string[] = [];
    const DEAD_KEY: ConversationKey = "coord-worker-to-orch";
    const PUBLISH_PATTERNS = [
      new RegExp(`send\\w*\\(\\s*['"\`]${DEAD_KEY}['"\`]`),
      new RegExp(`publish\\w*\\(\\s*['"\`]${DEAD_KEY}['"\`]`),
      new RegExp(`reply\\w*\\(\\s*['"\`]${DEAD_KEY}['"\`]`),
    ];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|mts|cts|tsx)$/.test(entry)) continue;
        const text = readFileSync(p, "utf8");
        for (const re of PUBLISH_PATTERNS) {
          if (re.test(text)) {
            offenders.push(p);
            break;
          }
        }
      }
    }
    for (const d of scanDirs) walk(join(root, d));
    expect(offenders).toEqual([]);
  });
});
