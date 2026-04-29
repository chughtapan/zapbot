import { describe, expect, it } from "vitest";

import {
  checkWorkspace,
  describeFixWorkspaceError,
  fixWorkspace,
  type FixWorkspaceDeps,
} from "../src/doctor/workspace.ts";

const SUBMODULE_SHA = "abcdef1234567890abcdef1234567890abcdef12";
const EFFECT_VERSION = "3.21.0";
const EXPECTED_STAMP = `1:${SUBMODULE_SHA}:${EFFECT_VERSION}`;

interface FakeFs {
  files: Map<string, string>;
  brokenSymlinks: string[];
  removed: string[];
}

interface FakeExecCalls {
  log: Array<{ command: string; args: readonly string[]; cwd: string }>;
  responses: Map<string, { stdout: string; stderr: string; code: number }>;
}

function makeDeps(opts: {
  files?: Record<string, string>;
  brokenSymlinks?: string[];
  /** Map of "command args.join(' ')" → response. */
  execResponses?: Record<string, { stdout?: string; stderr?: string; code?: number }>;
}): { deps: FixWorkspaceDeps; fs: FakeFs; exec: FakeExecCalls; logs: string[] } {
  const fs: FakeFs = {
    files: new Map(Object.entries(opts.files ?? {})),
    brokenSymlinks: [...(opts.brokenSymlinks ?? [])],
    removed: [],
  };
  const responses = new Map<string, { stdout: string; stderr: string; code: number }>();
  for (const [key, value] of Object.entries(opts.execResponses ?? {})) {
    responses.set(key, {
      stdout: value.stdout ?? "",
      stderr: value.stderr ?? "",
      code: value.code ?? 0,
    });
  }
  const exec: FakeExecCalls = { log: [], responses };
  const logs: string[] = [];

  const deps: FixWorkspaceDeps = {
    execFile: async (command, args, options) => {
      exec.log.push({ command, args, cwd: options.cwd });
      const key = `${command} ${args.join(" ")}`;
      const response = exec.responses.get(key) ?? exec.responses.get(command) ?? {
        stdout: "",
        stderr: "",
        code: 0,
      };
      return response;
    },
    readFile: async (path) => fs.files.get(path) ?? null,
    writeFile: async (path, content) => {
      fs.files.set(path, content);
    },
    findBrokenSymlinks: async (basePath) =>
      fs.brokenSymlinks.filter((p) => p.startsWith(basePath)),
    removePath: async (path) => {
      fs.removed.push(path);
      fs.brokenSymlinks = fs.brokenSymlinks.filter((p) => p !== path);
    },
    logger: (line) => logs.push(line),
  };

  return { deps, fs, exec, logs };
}

const PACKAGE_JSON_OK = JSON.stringify({
  dependencies: { effect: EFFECT_VERSION },
});

const LS_TREE_OUTPUT = `160000 commit ${SUBMODULE_SHA}\tvendor/moltzap`;

describe("fixWorkspace", () => {
  it("stamp present + matches → skips bootstrap and install, only re-scans", async () => {
    const { deps, exec, fs } = makeDeps({
      files: {
        "/work/package.json": PACKAGE_JSON_OK,
        "/work/.zapbot-doctor-stamp": EXPECTED_STAMP,
      },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await fixWorkspace("/work", deps);
    expect(result).toEqual({
      _tag: "Ok",
      value: { skipped: true, stamp: EXPECTED_STAMP, brokenSymlinksRemoved: 0 },
    });

    // Only git ls-tree should have run; no bootstrap, no bun install.
    expect(exec.log.map((c) => c.command)).toEqual(["git"]);
    expect(fs.files.get("/work/.zapbot-doctor-stamp")).toBe(EXPECTED_STAMP);
  });

  it("stamp absent → runs bootstrap + install + scan, then writes stamp", async () => {
    const { deps, exec, fs } = makeDeps({
      files: { "/work/package.json": PACKAGE_JSON_OK },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await fixWorkspace("/work", deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.skipped).toBe(false);
    expect(result.value.stamp).toBe(EXPECTED_STAMP);

    // Calls in order: git ls-tree, bash <bootstrap>, bun install.
    expect(exec.log.map((c) => c.command)).toEqual(["git", "bash", "bun"]);
    const installCall = exec.log[2];
    expect(installCall.args).toEqual(["install"]);
    expect(installCall.cwd).toBe("/work");

    // Stamp written.
    expect(fs.files.get("/work/.zapbot-doctor-stamp")?.trim()).toBe(EXPECTED_STAMP);
  });

  it("stamp present but mismatched → invalidates stamp, full re-provision", async () => {
    const STALE_STAMP = `1:${"0".repeat(40)}:3.20.0`;
    const { deps, exec, fs } = makeDeps({
      files: {
        "/work/package.json": PACKAGE_JSON_OK,
        "/work/.zapbot-doctor-stamp": STALE_STAMP,
      },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await fixWorkspace("/work", deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.skipped).toBe(false);

    expect(exec.log.map((c) => c.command)).toEqual(["git", "bash", "bun"]);
    expect(fs.files.get("/work/.zapbot-doctor-stamp")?.trim()).toBe(EXPECTED_STAMP);
  });

  it("bootstrap exits non-zero → BootstrapFailed with stderr", async () => {
    const { deps } = makeDeps({
      files: { "/work/package.json": PACKAGE_JSON_OK },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
        bash: { code: 2, stderr: "pnpm: command not found" },
      },
    });

    const result = await fixWorkspace("/work", deps);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BootstrapFailed");
    if (result.error._tag !== "BootstrapFailed") return;
    expect(result.error.path).toBe("/work");
    expect(result.error.stderr).toContain("pnpm: command not found");
  });

  it("bun install exits non-zero → InstallFailed with stderr", async () => {
    const { deps } = makeDeps({
      files: { "/work/package.json": PACKAGE_JSON_OK },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
        bash: { code: 0 },
        bun: { code: 1, stderr: "lockfile drift detected" },
      },
    });

    const result = await fixWorkspace("/work", deps);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("InstallFailed");
    if (result.error._tag !== "InstallFailed") return;
    expect(result.error.stderr).toContain("lockfile drift detected");
  });

  it("workspace missing package.json → WorkspaceMissing", async () => {
    const { deps } = makeDeps({});
    const result = await fixWorkspace("/no-such", deps);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("WorkspaceMissing");
  });

  it("removes broken symlinks under @moltzap during scan", async () => {
    const broken = [
      "/work/node_modules/@moltzap/app-sdk/node_modules/effect",
      "/work/node_modules/@moltzap/client/node_modules/pino",
    ];
    const { deps, fs } = makeDeps({
      files: {
        "/work/package.json": PACKAGE_JSON_OK,
        "/work/.zapbot-doctor-stamp": EXPECTED_STAMP,
      },
      brokenSymlinks: broken,
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await fixWorkspace("/work", deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.brokenSymlinksRemoved).toBe(2);
    expect(fs.removed.sort()).toEqual([...broken].sort());
  });
});

describe("checkWorkspace", () => {
  it("clean state → empty issues", async () => {
    const { deps } = makeDeps({
      files: {
        "/work/package.json": PACKAGE_JSON_OK,
        "/work/.zapbot-doctor-stamp": EXPECTED_STAMP,
      },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await checkWorkspace("/work", deps);
    expect(result).toEqual({ _tag: "Ok", value: [] });
  });

  it("missing stamp → reports unprovisioned", async () => {
    const { deps } = makeDeps({
      files: { "/work/package.json": PACKAGE_JSON_OK },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await checkWorkspace("/work", deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value).toContain("workspace not provisioned (no .zapbot-doctor-stamp)");
  });

  it("stamp drift → reports drift with old vs new", async () => {
    const STALE_STAMP = `1:0000000000000000000000000000000000000000:3.20.0`;
    const { deps } = makeDeps({
      files: {
        "/work/package.json": PACKAGE_JSON_OK,
        "/work/.zapbot-doctor-stamp": STALE_STAMP,
      },
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await checkWorkspace("/work", deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.some((s) => s.startsWith("stamp drift:"))).toBe(true);
  });

  it("broken symlinks → reports count", async () => {
    const { deps } = makeDeps({
      files: {
        "/work/package.json": PACKAGE_JSON_OK,
        "/work/.zapbot-doctor-stamp": EXPECTED_STAMP,
      },
      brokenSymlinks: [
        "/work/node_modules/@moltzap/app-sdk/node_modules/effect",
        "/work/node_modules/@moltzap/client/node_modules/effect",
      ],
      execResponses: {
        "git ls-tree HEAD vendor/moltzap": { stdout: LS_TREE_OUTPUT },
      },
    });

    const result = await checkWorkspace("/work", deps);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value).toContain("2 broken symlinks under node_modules/@moltzap/");
  });
});

describe("describeFixWorkspaceError", () => {
  it("BootstrapFailed message names path + diagnostic command", () => {
    const message = describeFixWorkspaceError({
      _tag: "BootstrapFailed",
      path: "/work",
      stderr: "pnpm: command not found",
    });
    expect(message).toContain("/work");
    expect(message).toContain("pnpm: command not found");
    expect(message).toContain("scripts/bootstrap-moltzap.sh /work");
  });

  it("InstallFailed message names cd command", () => {
    const message = describeFixWorkspaceError({
      _tag: "InstallFailed",
      path: "/work",
      stderr: "lockfile drift",
    });
    expect(message).toContain("cd /work && bun install");
  });

  it("WorkspaceMissing names reason", () => {
    const message = describeFixWorkspaceError({
      _tag: "WorkspaceMissing",
      path: "/no-such",
      reason: "no package.json",
    });
    expect(message).toContain("not a zapbot workspace");
    expect(message).toContain("no package.json");
  });
});
