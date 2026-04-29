/**
 * doctor/workspace — Contract A: idempotent workspace provisioning.
 *
 * Brings any zapbot workspace (main checkout, orchestrator worktree, worker
 * worktree) to a known-good state: submodule initialized, dist artifacts
 * built, manifest specifiers rewritten, nested pnpm symlinks pruned,
 * `node_modules/` populated by `bun install`, no broken nested symlinks
 * under `node_modules/@moltzap/<pkg>/node_modules/`.
 *
 * Idempotency: the bootstrap script writes
 * `<workspacePath>/.zapbot-bootstrap-stamp`. If the stamp matches the
 * expected `{submodule_sha}:{effect_version}` for this workspace, the
 * bootstrap is a fast no-op. The doctor itself writes
 * `<workspacePath>/.zapbot-doctor-stamp` capturing the higher-level
 * invariant (bootstrap + install + scan all clean for this state). When
 * the doctor stamp matches, full provisioning is skipped and only the
 * cheap symlink scan runs.
 *
 * Spawner injection seam: `FixWorkspaceDeps` lets tests substitute
 * `execFile`, fs operations, and the logger.
 */

import { absurd, err, ok } from "../types.ts";
import type { Result } from "../types.ts";

export interface FixWorkspaceDeps {
  readonly execFile: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env?: Record<string, string | undefined> },
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  /**
   * Enumerates broken symlinks under a base directory, recursing through
   * nested directories. A symlink is "broken" when its target does not
   * exist on disk. Returns the symlink paths.
   */
  readonly findBrokenSymlinks: (basePath: string) => Promise<readonly string[]>;
  /** Recursive `rm -rf` for cleanup. */
  readonly removePath: (path: string) => Promise<void>;
  readonly logger: (line: string) => void;
}

export type FixWorkspaceError =
  | { readonly _tag: "BootstrapFailed"; readonly path: string; readonly stderr: string }
  | { readonly _tag: "InstallFailed"; readonly path: string; readonly stderr: string }
  | { readonly _tag: "ScanFailed"; readonly path: string; readonly cause: string }
  | { readonly _tag: "WorkspaceMissing"; readonly path: string; readonly reason: string };

export interface FixWorkspaceOutcome {
  readonly skipped: boolean;
  readonly stamp: string;
  readonly brokenSymlinksRemoved: number;
}

/** Doctor stamp version: bump when fixWorkspace changes its contract. */
const DOCTOR_STAMP_VERSION = "1";

/**
 * Apply Contract A to `workspacePath`. Idempotent. Stamp-skipped on
 * subsequent calls when state has not changed.
 */
export async function fixWorkspace(
  workspacePath: string,
  deps: FixWorkspaceDeps,
): Promise<Result<FixWorkspaceOutcome, FixWorkspaceError>> {
  // 0. Validate workspace shape.
  const pkgJsonRaw = await deps.readFile(`${workspacePath}/package.json`);
  if (pkgJsonRaw === null) {
    return err({
      _tag: "WorkspaceMissing",
      path: workspacePath,
      reason: "no package.json — not a zapbot workspace",
    });
  }
  const effectVersion = readEffectVersion(pkgJsonRaw);
  if (effectVersion === null) {
    return err({
      _tag: "WorkspaceMissing",
      path: workspacePath,
      reason: "package.json has no dependencies.effect — not a zapbot workspace",
    });
  }

  // 1. Compute expected stamp.
  const submoduleShaResult = await readSubmoduleSha(workspacePath, deps);
  if (submoduleShaResult._tag === "Err") return submoduleShaResult;
  const submoduleSha = submoduleShaResult.value;

  const expectedStamp = `${DOCTOR_STAMP_VERSION}:${submoduleSha}:${effectVersion}`;
  const existingStamp = await deps.readFile(`${workspacePath}/.zapbot-doctor-stamp`);
  const stampHit = existingStamp !== null && existingStamp.trim() === expectedStamp;

  // 2. Stamp-skip path: only re-verify symlink integrity (cheap).
  if (stampHit) {
    deps.logger(`[doctor] stamp matches (${expectedStamp}); verifying integrity.`);
    const scanResult = await scanAndFixSymlinks(workspacePath, deps);
    if (scanResult._tag === "Err") return scanResult;
    return ok({
      skipped: true,
      stamp: expectedStamp,
      brokenSymlinksRemoved: scanResult.value,
    });
  }

  // 3. Full provision: bootstrap → install → scan → stamp.
  deps.logger(`[doctor] provisioning workspace at ${workspacePath}.`);

  const bootstrapResult = await runBootstrap(workspacePath, deps);
  if (bootstrapResult._tag === "Err") return bootstrapResult;

  const installResult = await runInstall(workspacePath, deps);
  if (installResult._tag === "Err") return installResult;

  const scanResult = await scanAndFixSymlinks(workspacePath, deps);
  if (scanResult._tag === "Err") return scanResult;

  await deps.writeFile(`${workspacePath}/.zapbot-doctor-stamp`, `${expectedStamp}\n`);
  deps.logger(`[doctor] provisioning complete; stamp: ${expectedStamp}.`);

  return ok({
    skipped: false,
    stamp: expectedStamp,
    brokenSymlinksRemoved: scanResult.value,
  });
}

/**
 * Read-only audit of the same invariants. Returns the list of issues
 * found without mutating anything. Used by `zapbot-doctor check`.
 */
export async function checkWorkspace(
  workspacePath: string,
  deps: FixWorkspaceDeps,
): Promise<Result<readonly string[], FixWorkspaceError>> {
  const issues: string[] = [];

  const pkgJsonRaw = await deps.readFile(`${workspacePath}/package.json`);
  if (pkgJsonRaw === null) {
    return err({
      _tag: "WorkspaceMissing",
      path: workspacePath,
      reason: "no package.json",
    });
  }
  const effectVersion = readEffectVersion(pkgJsonRaw);
  if (effectVersion === null) {
    issues.push("package.json missing dependencies.effect");
  }

  const submoduleShaResult = await readSubmoduleSha(workspacePath, deps);
  if (submoduleShaResult._tag === "Err") return submoduleShaResult;
  const submoduleSha = submoduleShaResult.value;

  if (effectVersion !== null) {
    const expectedStamp = `${DOCTOR_STAMP_VERSION}:${submoduleSha}:${effectVersion}`;
    const existingStamp = await deps.readFile(`${workspacePath}/.zapbot-doctor-stamp`);
    if (existingStamp === null) {
      issues.push("workspace not provisioned (no .zapbot-doctor-stamp)");
    } else if (existingStamp.trim() !== expectedStamp) {
      issues.push(
        `stamp drift: expected ${expectedStamp}, found ${existingStamp.trim()}`,
      );
    }
  }

  // Always scan for broken symlinks, even when stamp would match.
  const broken = await deps.findBrokenSymlinks(`${workspacePath}/node_modules/@moltzap`);
  if (broken.length > 0) {
    issues.push(`${broken.length} broken symlinks under node_modules/@moltzap/`);
  }

  return ok(issues);
}

// ── internals ──────────────────────────────────────────────────────────

function readEffectVersion(pkgJsonRaw: string): string | null {
  try {
    const j = JSON.parse(pkgJsonRaw) as { dependencies?: Record<string, string> };
    const v = j.dependencies?.effect;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function readSubmoduleSha(
  workspacePath: string,
  deps: FixWorkspaceDeps,
): Promise<Result<string, FixWorkspaceError>> {
  const result = await deps.execFile("git", ["ls-tree", "HEAD", "vendor/moltzap"], {
    cwd: workspacePath,
  });
  if (result.code !== 0) {
    return err({
      _tag: "WorkspaceMissing",
      path: workspacePath,
      reason: `git ls-tree failed (code ${result.code}): ${result.stderr}`,
    });
  }
  const sha = result.stdout.trim().split(/\s+/)[2];
  if (sha === undefined || sha.length === 0) {
    return err({
      _tag: "WorkspaceMissing",
      path: workspacePath,
      reason: "vendor/moltzap is not a submodule of this workspace",
    });
  }
  return ok(sha);
}

async function runBootstrap(
  workspacePath: string,
  deps: FixWorkspaceDeps,
): Promise<Result<void, FixWorkspaceError>> {
  // The bootstrap script lives in the *main* checkout; the workspace may
  // be a worktree. We invoke the script via its absolute path, passing the
  // workspace as TARGET_ROOT.
  const scriptPath = mainCheckoutBootstrapPath(workspacePath, deps);
  const result = await deps.execFile("bash", [scriptPath, workspacePath], {
    cwd: workspacePath,
  });
  if (result.code !== 0) {
    return err({
      _tag: "BootstrapFailed",
      path: workspacePath,
      stderr: shortStderr(result.stderr || result.stdout),
    });
  }
  return ok(undefined);
}

async function runInstall(
  workspacePath: string,
  deps: FixWorkspaceDeps,
): Promise<Result<void, FixWorkspaceError>> {
  // Plain `bun install` (NOT --frozen-lockfile) because the bootstrap
  // rewrites manifests after lock generation; frozen would hard-fail.
  // Drift surfaces via `zapbot-doctor check`, not by refusing to install.
  // We pass NO_POSTINSTALL=1 to break the recursion: doctor → bun install
  // would otherwise trigger the package.json postinstall hook (which
  // re-invokes the doctor). Stamp-skip would catch the recursion eventually
  // but the env flag is the explicit guard.
  const result = await deps.execFile("bun", ["install"], {
    cwd: workspacePath,
    env: { ...process.env, ZAPBOT_DOCTOR_NO_POSTINSTALL: "1" },
  });
  if (result.code !== 0) {
    return err({
      _tag: "InstallFailed",
      path: workspacePath,
      stderr: shortStderr(result.stderr || result.stdout),
    });
  }
  return ok(undefined);
}

async function scanAndFixSymlinks(
  workspacePath: string,
  deps: FixWorkspaceDeps,
): Promise<Result<number, FixWorkspaceError>> {
  let broken: readonly string[];
  try {
    broken = await deps.findBrokenSymlinks(`${workspacePath}/node_modules/@moltzap`);
  } catch (cause) {
    return err({
      _tag: "ScanFailed",
      path: workspacePath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  for (const path of broken) {
    deps.logger(`[doctor] removing broken symlink: ${path}`);
    await deps.removePath(path);
  }
  return ok(broken.length);
}

/**
 * Resolve the path to scripts/bootstrap-moltzap.sh in the *main* checkout,
 * regardless of which worktree we are provisioning. The doctor module itself
 * lives under <main-checkout>/src/doctor/, so the bootstrap script is at
 * a known relative offset.
 */
function mainCheckoutBootstrapPath(workspacePath: string, deps: FixWorkspaceDeps): string {
  // We can resolve from import.meta.url at the call site, but to keep the
  // function pure for testability we accept it via deps when needed and
  // otherwise compute from a known offset relative to this module's URL.
  void workspacePath;
  void deps;
  return new URL("../../scripts/bootstrap-moltzap.sh", import.meta.url).pathname;
}

function shortStderr(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 800) return trimmed;
  return `${trimmed.slice(0, 800)}\n…(truncated ${trimmed.length - 800} bytes)`;
}

/**
 * Coerce a `FixWorkspaceError` to the user-actionable single-line message
 * that operators see in their terminal. Names the workspace path, the
 * failing step, and the diagnostic command.
 */
export function describeFixWorkspaceError(error: FixWorkspaceError): string {
  switch (error._tag) {
    case "BootstrapFailed":
      return `bootstrap failed for workspace ${error.path}\n  cause: ${error.stderr}\n  diagnose: bash scripts/bootstrap-moltzap.sh ${error.path}`;
    case "InstallFailed":
      return `bun install failed for workspace ${error.path}\n  cause: ${error.stderr}\n  diagnose: cd ${error.path} && bun install`;
    case "ScanFailed":
      return `symlink scan failed for ${error.path}\n  cause: ${error.cause}\n  diagnose: ls -la ${error.path}/node_modules/@moltzap`;
    case "WorkspaceMissing":
      return `not a zapbot workspace: ${error.path}\n  reason: ${error.reason}`;
    default:
      return absurd(error);
  }
}
