/**
 * test/integration/globalSetup — vitest globalSetup for MoltZap integration.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 CI-fixture bullet (a)-(f); Spike B verdict
 * (sbd#182); sbd#203 Phase 1.
 *
 * Spec-binding constraints:
 *   (a) subprocess backed by vendor/moltzap/packages/server/dist/standalone.js
 *   (b) PGlite — MOLTZAP_DEV_MODE=true omits DATABASE_URL; dev_mode.enabled in
 *       YAML auto-assigns owner_user_id so agents can initiate app sessions
 *   (c) fresh subprocess per suite (12–15 s cold boot; too slow for per-test)
 *   (d) ENCRYPTION_MASTER_SECRET = randomBytes(32).toString("base64")
 *   (e) subprocess SIGTERMed at suite teardown; SIGKILL after 5 s grace
 *   (f) tests reach server over HTTP+WS at localhost:41990
 *
 * Pre-req: `cd vendor/moltzap && pnpm install --frozen-lockfile && pnpm -r build`
 * must have been run once. The setup throws a named error if the binary is absent.
 *
 * Tests read server coordinates via:
 *   import { inject } from "vitest";
 *   const HTTP_BASE = inject("moltzapHttpBaseUrl") as string;
 *   const WS_BASE   = inject("moltzapWsBaseUrl")   as string;
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";

const __dirname = dirname(fileURLToPath(import.meta.url));

const STANDALONE_PATH = join(
  __dirname,
  "../../vendor/moltzap/packages/server/dist/standalone.js",
);

/** Fixed port for the integration test server. */
export const TEST_PORT = 41990;

const HTTP_BASE_URL = `http://localhost:${TEST_PORT}`;
const WS_BASE_URL = `ws://localhost:${TEST_PORT}`;

const BOOT_TIMEOUT_MS = 25_000;
const POLL_INTERVAL_MS = 600;

// ── Public exported types ────────────────────────────────────────────

export interface MoltzapTestServerHandle {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly pid: number;
}

export type GlobalSetupError =
  | { readonly _tag: "StandaloneBinaryMissing"; readonly expectedPath: string }
  | { readonly _tag: "BootTimeout"; readonly waitedMs: number }
  | {
      readonly _tag: "UnexpectedSubprocessExit";
      readonly exitCode: number;
      readonly stderr: string;
    }
  | { readonly _tag: "EncryptionSecretInvalid"; readonly reason: string };

// ── Entry ────────────────────────────────────────────────────────────

/**
 * vitest calls this once before the suite runs. Returns a teardown
 * function that vitest invokes after the suite completes.
 *
 * On success: provides "moltzapHttpBaseUrl" and "moltzapWsBaseUrl" via
 * vitest's inject API.
 *
 * Fail modes (named via GlobalSetupError):
 *   StandaloneBinaryMissing — vendor dist not built; run the pre-req
 *   BootTimeout             — server did not reach /health in 25 s
 *   UnexpectedSubprocessExit — server crashed before becoming ready
 */
export default async function setup({
  provide,
}: GlobalSetupContext): Promise<() => Promise<void>> {
  // Kill any stale server from a previous run that did not tear down cleanly.
  // Runs `fuser -k PORT/tcp`; silently ignored if fuser is absent or the
  // port is already free. Without this, the second vitest run would attach
  // to the old PGlite DB and cause agent-name UNIQUE-constraint failures.
  await killPortIfOccupied(TEST_PORT);

  if (!existsSync(STANDALONE_PATH)) {
    const e: GlobalSetupError = {
      _tag: "StandaloneBinaryMissing",
      expectedPath: STANDALONE_PATH,
    };
    throw new Error(
      `[moltzap-globalSetup] ${e._tag}: ${e.expectedPath}\n` +
        "Fix: cd vendor/moltzap && pnpm install --frozen-lockfile && pnpm -r build",
    );
  }

  // Minimal YAML config: open CORS, dev mode enabled so registered agents
  // get auto-assigned owner_user_id (required for apps/create).
  const configPath = join(tmpdir(), `moltzap-test-${process.pid}.yaml`);
  writeFileSync(
    configPath,
    [
      "server:",
      '  cors_origins: ["*"]',
      "dev_mode:",
      "  enabled: true",
      "log_level: warn",
      "",
    ].join("\n"),
    "utf8",
  );

  const encryptionSecret = randomBytes(32).toString("base64");

  const proc = spawn("node", [STANDALONE_PATH], {
    env: {
      ...process.env,
      MOLTZAP_CONFIG: configPath,
      PORT: String(TEST_PORT),
      MOLTZAP_DEV_MODE: "true",
      ENCRYPTION_MASTER_SECRET: encryptionSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  proc.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  let earlyExitCode: number | null = null;
  proc.once("exit", (code) => {
    earlyExitCode = code ?? 1;
  });

  await waitUntilReady();

  provide("moltzapHttpBaseUrl", HTTP_BASE_URL);
  provide("moltzapWsBaseUrl", WS_BASE_URL);

  return async () => {
    if (proc.pid !== undefined && !proc.killed) {
      proc.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const graceful = setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 5_000);
        proc.once("exit", () => {
          clearTimeout(graceful);
          resolve();
        });
      });
    }
  };

  // ── Private helper ─────────────────────────────────────────────────

  async function waitUntilReady(): Promise<void> {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (earlyExitCode !== null) {
        const stderr = Buffer.concat(stderrChunks)
          .toString("utf8")
          .slice(0, 3000);
        throw new Error(
          `[moltzap-globalSetup] UnexpectedSubprocessExit: code ${earlyExitCode}\n${stderr}`,
        );
      }
      try {
        const res = await fetch(`${HTTP_BASE_URL}/health`, {
          signal: AbortSignal.timeout(Math.min(POLL_INTERVAL_MS, 2_000)),
        });
        if (res.ok) return;
      } catch {
        // ECONNREFUSED or AbortError — server not ready yet
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error(
      `[moltzap-globalSetup] BootTimeout: GET ${HTTP_BASE_URL}/health ` +
        `did not return 200 within ${BOOT_TIMEOUT_MS}ms`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort: kill any process listening on `port` before we spawn our own.
 * Uses `fuser -k PORT/tcp`; silently swallows errors (fuser absent, no
 * process, permission denied). Waits up to 800 ms for the port to be released.
 *
 * Port-scoping rationale: The test setup pins the port to a deterministic value
 * (TEST_PORT=41990) and runs in isolated CI environments where this port is not
 * expected to be in use by unrelated services. PID-scoping (kill only our
 * previous test process) would be more precise but requires tracking the prior
 * process ID across restarts, adding complexity without benefit in the test
 * isolation model.
 */
async function killPortIfOccupied(port: number): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const killer = spawn("fuser", ["-k", `${port}/tcp`], {
        stdio: "ignore",
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
    // Give the OS a moment to release the socket.
    await sleep(800);
  } catch {
    // fuser not available or nothing to kill — proceed.
  }
}
