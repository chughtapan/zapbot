/**
 * test/integration/globalSetup — vitest globalSetup for MoltZap integration.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 CI-fixture bullet (a)-(f); Spike B verdict
 * (sbd#182).
 *
 * Spec-binding constraints this module realizes:
 *   (a) subprocess backed by `node ~/moltzap/packages/server/dist/standalone.js`
 *   (b) PGlite (no docker, no external DB)
 *   (c) fresh subprocess per suite — NOT per test (12–15 s cold boot)
 *   (d) `ENCRYPTION_MASTER_SECRET` sourced as 32-byte base64 at suite setup
 *   (e) subprocess SIGTERMed at suite teardown
 *   (f) tests reach the server over HTTP+WS at `localhost:<port>`
 *
 * Pre-req (operator note): `pnpm install && pnpm build` in `~/moltzap/` has
 * been run once. The setup fails fast with a named error if the standalone
 * binary is missing.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface MoltzapTestServerHandle {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly pid: number;
}

export type GlobalSetupError =
  | { readonly _tag: "StandaloneBinaryMissing"; readonly expectedPath: string }
  | { readonly _tag: "BootTimeout"; readonly waitedMs: number }
  | { readonly _tag: "UnexpectedSubprocessExit"; readonly exitCode: number; readonly stderr: string }
  | { readonly _tag: "EncryptionSecretInvalid"; readonly reason: string };

const STANDALONE_PATH = join(
  homedir(),
  "moltzap",
  "packages",
  "server",
  "dist",
  "standalone.js",
);
const BOOT_TIMEOUT_MS = 20_000;
const DEFAULT_PORT = 41975;

async function pollReady(httpUrl: string, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    try {
      const r = await fetch(`${httpUrl}/api/v1/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok || r.status === 404) {
        // 404 means the server answered HTTP — close enough for boot-readiness.
        return true;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function materializeConfig(configDir: string, port: number): string {
  const configPath = join(configDir, "moltzap.yaml");
  writeFileSync(
    configPath,
    `server:\n  port: ${port}\n  cors_origins:\n    - "*"\ndev_mode:\n  enabled: true\nregistration:\n  secret: zapbot-integration-probe\n`,
    "utf8",
  );
  return configPath;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (!existsSync(STANDALONE_PATH)) {
    throw new Error(
      `[integration] ${JSON.stringify({
        _tag: "StandaloneBinaryMissing",
        expectedPath: STANDALONE_PATH,
      } satisfies GlobalSetupError)}`,
    );
  }

  const encryptionSecret = randomBytes(32).toString("base64");
  if (encryptionSecret.length < 40) {
    throw new Error(
      `[integration] ${JSON.stringify({
        _tag: "EncryptionSecretInvalid",
        reason: `base64 length ${encryptionSecret.length} < 40`,
      } satisfies GlobalSetupError)}`,
    );
  }

  const configDir = `/tmp/zapbot-integration-${process.pid}-${Date.now()}`;
  mkdirSync(configDir, { recursive: true });
  const port = DEFAULT_PORT;
  const configPath = materializeConfig(configDir, port);

  const child: ChildProcess = spawn(
    "node",
    [STANDALONE_PATH],
    {
      cwd: configDir,
      env: {
        ...process.env,
        ENCRYPTION_MASTER_SECRET: encryptionSecret,
        MOLTZAP_CONFIG_PATH: configPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", () => {
    // discard — server pino logs are noisy
  });

  const httpBaseUrl = `http://127.0.0.1:${port}`;
  const wsBaseUrl = `ws://127.0.0.1:${port}`;

  const ready = await pollReady(httpBaseUrl, Date.now() + BOOT_TIMEOUT_MS);
  if (!ready) {
    try {
      child.kill("SIGTERM");
    } catch {
      // best-effort
    }
    throw new Error(
      `[integration] ${JSON.stringify({
        _tag: "BootTimeout",
        waitedMs: BOOT_TIMEOUT_MS,
      } satisfies GlobalSetupError)}\nstderr:\n${stderr}`,
    );
  }

  // Publish endpoints to the test files.
  (globalThis as unknown as { MOLTZAP_TEST_HTTP_BASE?: string }).MOLTZAP_TEST_HTTP_BASE =
    httpBaseUrl;
  (globalThis as unknown as { MOLTZAP_TEST_WS_BASE?: string }).MOLTZAP_TEST_WS_BASE =
    wsBaseUrl;
  process.env.MOLTZAP_TEST_HTTP_BASE = httpBaseUrl;
  process.env.MOLTZAP_TEST_WS_BASE = wsBaseUrl;

  // eslint-disable-next-line no-console
  console.error(
    `[integration] moltzap standalone up on ${httpBaseUrl} (pid=${child.pid ?? "?"})`,
  );
  void readFileSync; // avoid tree-shake noise

  return async function teardown(): Promise<void> {
    try {
      child.kill("SIGTERM");
    } catch {
      // best-effort
    }
  };
}
