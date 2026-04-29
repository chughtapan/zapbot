/**
 * Integration test for zapbot-doctor's dangling-symlink regression.
 *
 * This test guards against the failure mode hit twice in the 2026-04-29
 * fragility session: `bun install` consuming `vendor/moltzap/packages/*`
 * via `file:` deps copies pnpm-style nested `node_modules/effect →
 * .pnpm/effect@.../...` symlinks into `node_modules/@moltzap/<pkg>/node_modules/`
 * but the .pnpm/ store doesn't follow, so the symlinks dangle and the
 * bridge crashes at startup with `ENOENT reading effect`.
 *
 * The test constructs the dangling state, runs `findBrokenSymlinks` +
 * `removePath` (the same path the doctor takes during scan), and asserts
 * the broken links are reaped. If a future change reintroduces the failure
 * mode (e.g., by adding a postinstall step that copies the broken symlinks
 * back), this test fails.
 *
 * Marked integration because it touches a real temp filesystem.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  promises as fsPromises,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkWorkspace,
  fixWorkspace,
  type FixWorkspaceDeps,
} from "../src/doctor/workspace.ts";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "zapbot-doctor-it-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const SUBMODULE_SHA = "d869317133c569362e58badc4d81ef450eb9b1a3";
const EFFECT_VERSION = "3.21.0";
const STAMP = `1:${SUBMODULE_SHA}:${EFFECT_VERSION}`;

function bootstrapWorkspaceShape(): void {
  // Minimal workspace: package.json with effect, .zapbot-doctor-stamp matching,
  // an @moltzap/app-sdk/node_modules tree containing a broken symlink.
  writeFileSync(
    join(workspace, "package.json"),
    JSON.stringify({ dependencies: { effect: EFFECT_VERSION } }),
    "utf8",
  );
  writeFileSync(join(workspace, ".zapbot-doctor-stamp"), STAMP, "utf8");

  const moltzap = join(workspace, "node_modules/@moltzap/app-sdk/node_modules");
  mkdirSync(moltzap, { recursive: true });
  symlinkSync(
    "../../../../node_modules/.pnpm/effect@3.21.0/node_modules/effect", // target does NOT exist
    join(moltzap, "effect"),
  );

  const clientNm = join(workspace, "node_modules/@moltzap/client/node_modules");
  mkdirSync(clientNm, { recursive: true });
  symlinkSync(
    "../../../../node_modules/.pnpm/pino@9.14.0/node_modules/pino", // also broken
    join(clientNm, "pino"),
  );
}

/**
 * Real fs-backed deps that point at the temp workspace. Stubs the
 * git ls-tree call (we do not have a real submodule).
 */
function makeIntegrationDeps(): FixWorkspaceDeps {
  return {
    execFile: async (command, args, _options) => {
      if (command === "git" && args[0] === "ls-tree") {
        return {
          stdout: `160000 commit ${SUBMODULE_SHA}\tvendor/moltzap`,
          stderr: "",
          code: 0,
        };
      }
      // We do not exercise bash/bun in this integration test (the stamp
      // matches, so the doctor takes the cheap-path scan only).
      return { stdout: "", stderr: "", code: 0 };
    },
    readFile: async (path) => {
      try {
        return await fsPromises.readFile(path, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
    },
    writeFile: async (path, content) => {
      await fsPromises.writeFile(path, content, "utf8");
    },
    findBrokenSymlinks: async (basePath) => {
      const broken: string[] = [];
      await collectBroken(basePath, broken);
      return broken;
    },
    removePath: async (path) => {
      await fsPromises.rm(path, { recursive: true, force: true });
    },
    logger: () => undefined,
  };
}

async function collectBroken(basePath: string, broken: string[]): Promise<void> {
  if (!existsSync(basePath)) return;
  let entries;
  try {
    entries = await fsPromises.readdir(basePath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childPath = join(basePath, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        statSync(childPath); // follows symlinks
      } catch {
        broken.push(childPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      await collectBroken(childPath, broken);
    }
  }
}

describe("zapbot-doctor: dangling-symlink regression", () => {
  it("reaps broken nested @moltzap symlinks during scan (the 2026-04-29 incident)", async () => {
    bootstrapWorkspaceShape();
    const deps = makeIntegrationDeps();

    // Pre-state: scan finds the broken links.
    const issuesBefore = await checkWorkspace(workspace, deps);
    expect(issuesBefore._tag).toBe("Ok");
    if (issuesBefore._tag !== "Ok") return;
    expect(issuesBefore.value).toContain("2 broken symlinks under node_modules/@moltzap/");

    // fixWorkspace runs the cheap-path scan because the stamp matches.
    const result = await fixWorkspace(workspace, deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.skipped).toBe(true);
    expect(result.value.brokenSymlinksRemoved).toBe(2);

    // Post-state: clean.
    const issuesAfter = await checkWorkspace(workspace, deps);
    expect(issuesAfter._tag).toBe("Ok");
    if (issuesAfter._tag !== "Ok") return;
    expect(issuesAfter.value).toEqual([]);

    // Filesystem invariant: the symlinks are gone.
    expect(
      existsSync(join(workspace, "node_modules/@moltzap/app-sdk/node_modules/effect")),
    ).toBe(false);
    expect(
      existsSync(join(workspace, "node_modules/@moltzap/client/node_modules/pino")),
    ).toBe(false);
  });

  it("a clean workspace stays clean after a doctor run", async () => {
    writeFileSync(
      join(workspace, "package.json"),
      JSON.stringify({ dependencies: { effect: EFFECT_VERSION } }),
      "utf8",
    );
    writeFileSync(join(workspace, ".zapbot-doctor-stamp"), STAMP, "utf8");
    // No nested node_modules at all — clean from the start.

    const deps = makeIntegrationDeps();
    const result = await fixWorkspace(workspace, deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.brokenSymlinksRemoved).toBe(0);
  });
});
