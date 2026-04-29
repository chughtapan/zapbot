#!/usr/bin/env bun
/**
 * zapbot-doctor — CLI for workspace provisioning + launch reconciliation.
 *
 * Subcommands:
 *   check                   read-only audit; exit 0 = clean, 1 = issues
 *   fix-workspace [PATH]    apply Contract A to PATH (default cwd)
 *   fix-launch              apply Contract B (stub in this PR; lands in PR2)
 *   fix                     fix-workspace + fix-launch
 *
 * The doctor is callable from four places:
 *   1. `start.sh` (preflight, before AO startup)
 *   2. `package.json` postinstall (after every `bun install`)
 *   3. `worker/ao-plugin-agent-claude-moltzap/index.js` setupWorkspaceHooks
 *      (before claude launches in an orchestrator worktree)
 *   4. `bin/ao-spawn-with-moltzap.ts` (before tmux session creation in a
 *      worker worktree)
 *
 * The CLI is a thin wrapper around src/doctor/workspace.ts. Real
 * implementation lives there with an injection seam for tests.
 */

import { execFile as execFileCb } from "node:child_process";
import {
  mkdtempSync,
  promises as fs,
  readlinkSync,
  statSync,
  Dirent,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  checkWorkspace,
  describeFixWorkspaceError,
  fixWorkspace,
  type FixWorkspaceDeps,
  type FixWorkspaceError,
} from "../src/doctor/workspace.ts";
import type { Result } from "../src/types.ts";

const execFileAsync = promisify(execFileCb);

// Postinstall recursion guard: when bun install runs the postinstall hook,
// the doctor would re-invoke `bun install` again from inside the workspace.
// fixWorkspace passes ZAPBOT_DOCTOR_NO_POSTINSTALL=1 to its child install,
// and the postinstall hook checks this env to short-circuit.
if (process.env.ZAPBOT_DOCTOR_NO_POSTINSTALL === "1" && isPostinstallContext(process.argv)) {
  console.log("[doctor] postinstall recursion guard tripped — skipping.");
  process.exit(0);
}

const args = process.argv.slice(2);
const subcommand = args[0] ?? "fix";

main(subcommand, args.slice(1)).catch((cause) => {
  console.error("[doctor] unexpected error:", cause);
  process.exit(2);
});

async function main(subcommand: string, rest: readonly string[]): Promise<void> {
  switch (subcommand) {
    case "check":
      await runCheck(rest);
      return;
    case "fix-workspace":
      await runFixWorkspace(rest);
      return;
    case "fix-launch":
      await runFixLaunch(rest);
      return;
    case "fix":
      await runFixWorkspace(rest);
      await runFixLaunch(rest);
      return;
    case "--help":
    case "-h":
    case "help":
      printUsage();
      return;
    default:
      console.error(`[doctor] unknown subcommand: ${subcommand}`);
      printUsage();
      process.exit(2);
  }
}

async function runCheck(rest: readonly string[]): Promise<void> {
  const target = resolve(rest[0] ?? process.cwd());
  const deps = makeDefaultDeps();
  const result = await checkWorkspace(target, deps);
  if (result._tag === "Err") {
    console.error(`[doctor] check failed: ${describeFixWorkspaceError(result.error)}`);
    process.exit(1);
  }
  if (result.value.length === 0) {
    console.log(`[doctor] ${target}: clean.`);
    process.exit(0);
  }
  console.log(`[doctor] ${target}: ${result.value.length} issue(s):`);
  for (const issue of result.value) {
    console.log(`  - ${issue}`);
  }
  process.exit(1);
}

async function runFixWorkspace(rest: readonly string[]): Promise<void> {
  const target = resolve(rest[0] ?? process.cwd());
  const deps = makeDefaultDeps();
  const result = await fixWorkspace(target, deps);
  if (result._tag === "Err") {
    // WorkspaceMissing is idempotent-skip territory: the caller pointed us
    // at a directory that is not a zapbot workspace (e.g., a test fixture,
    // an unrelated checkout). Log + exit 0 — `fix-workspace` is forgiving.
    // Use `check` for strict validation; it surfaces this as an issue.
    if (result.error._tag === "WorkspaceMissing") {
      console.log(`[doctor] ${target}: not a zapbot workspace, skipping.`);
      return;
    }
    console.error(`[doctor] fix-workspace failed:\n${describeFixWorkspaceError(result.error)}`);
    process.exit(1);
  }
  if (result.value.skipped) {
    console.log(
      `[doctor] ${target}: stamp matched (${result.value.stamp}); ` +
        `${result.value.brokenSymlinksRemoved} broken symlinks repaired.`,
    );
  } else {
    console.log(
      `[doctor] ${target}: provisioned (${result.value.stamp}); ` +
        `${result.value.brokenSymlinksRemoved} broken symlinks repaired.`,
    );
  }
}

async function runFixLaunch(_rest: readonly string[]): Promise<void> {
  // Contract B (launch-state reconciliation) lands in PR2.
  // The stub keeps the CLI surface stable so callers can wire `zapbot-doctor fix`
  // today and pick up reconciler behaviour transparently when PR2 ships.
  console.log("[doctor] fix-launch: not yet implemented (PR2). No-op.");
}

function printUsage(): void {
  console.log(`Usage: zapbot-doctor <subcommand> [args]

Subcommands:
  check [PATH]          Read-only audit. Exits 0 = clean, 1 = issues found.
  fix-workspace [PATH]  Apply Contract A (workspace provisioning) to PATH.
                        Default PATH = current directory.
  fix-launch            Apply Contract B (launch-state reconciliation).
                        (stubbed in this PR; lands in PR2)
  fix                   fix-workspace + fix-launch.

Run via:
  bun bin/zapbot-doctor.ts <subcommand> [args]
`);
}

// ── default deps (real fs + spawned processes) ────────────────────────

function makeDefaultDeps(): FixWorkspaceDeps {
  return {
    execFile: async (command, args, options) => {
      try {
        const { stdout, stderr } = await execFileAsync(command, [...args], {
          cwd: options.cwd,
          env: options.env as NodeJS.ProcessEnv | undefined,
          maxBuffer: 32 * 1024 * 1024,
        });
        return { stdout, stderr, code: 0 };
      } catch (cause) {
        const exitCode =
          typeof (cause as { code?: number }).code === "number"
            ? (cause as { code: number }).code
            : 1;
        const stderr =
          typeof (cause as { stderr?: string }).stderr === "string"
            ? (cause as { stderr: string }).stderr
            : cause instanceof Error
              ? cause.message
              : String(cause);
        const stdout =
          typeof (cause as { stdout?: string }).stdout === "string"
            ? (cause as { stdout: string }).stdout
            : "";
        return { stdout, stderr, code: exitCode };
      }
    },

    readFile: async (path) => {
      try {
        return await fs.readFile(path, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
    },

    writeFile: async (path, content) => {
      await fs.writeFile(path, content, "utf8");
    },

    findBrokenSymlinks: async (basePath) => {
      const broken: string[] = [];
      try {
        await collectBrokenSymlinks(basePath, broken);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          // No @moltzap dir yet (fresh checkout pre-bun-install): nothing to scan.
          return broken;
        }
        throw cause;
      }
      return broken;
    },

    removePath: async (path) => {
      await fs.rm(path, { recursive: true, force: true });
    },

    logger: (line) => console.log(line),
  };
}

async function collectBrokenSymlinks(basePath: string, broken: string[]): Promise<void> {
  const entries = await fs.readdir(basePath, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(basePath, entry.name);
    if (entry.isSymbolicLink()) {
      if (!isReachable(childPath)) {
        broken.push(childPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      await collectBrokenSymlinks(childPath, broken);
    }
  }
}

function isReachable(path: string): boolean {
  try {
    statSync(path); // follows symlinks
    return true;
  } catch {
    return false;
  }
}

// ── postinstall recursion guard helpers ───────────────────────────────

function isPostinstallContext(argv: readonly string[]): boolean {
  // argv looks like: [bun, bin/zapbot-doctor.ts, fix-workspace, .]
  // Postinstall always invokes with `fix-workspace .`. We use that signature.
  if (argv.length < 4) return false;
  const sub = argv[2];
  const path = argv[3];
  return sub === "fix-workspace" && (path === "." || path === process.cwd());
}

// Mute unused-Dirent + unused-readlinkSync for now; future scan modes use them.
void Dirent;
void readlinkSync;
void mkdtempSync;
