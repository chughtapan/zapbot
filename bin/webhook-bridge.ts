/**
 * bin/webhook-bridge — entrypoint.
 *
 * v1's bridge carried the HTTP server, HMAC verify, mention dispatch,
 * state-machine engine, SQLite store, plannotator callbacks, and recovery.
 * The live runtime now sits under `src/`; this file is only the CLI shim
 * that reads config, boots the server, and wires signals.
 */

import { readFileSync } from "fs";
import {
  deriveConfigSourcePaths,
  loadBridgeRuntimeConfig,
} from "../src/config/load.ts";
import { parseEnvFile, resolveRuntimeEnv } from "../src/config/env.ts";
import { parseProjectConfig, readConfigFiles } from "../src/config/disk.ts";
import { reloadBridgeRuntimeConfig } from "../src/config/reload.ts";
import type { BridgeRuntimeConfig } from "../src/config/types.ts";
import { createLogger } from "../src/logger.ts";
import { loadMoltzapRuntimeConfig } from "../src/moltzap/runtime.ts";
import { startBridge, type BridgeConfig, type RepoRoute } from "../src/bridge.ts";
import {
  asRepoFullName,
  err,
  ok,
  type Result,
} from "../src/types.ts";

process.on("unhandledRejection", (err) => {
  console.error("[bridge] Unhandled rejection (non-fatal):", err instanceof Error ? err.message : err);
});

const log = createLogger("bridge");

const nodeDiskReader = {
  readText(path: string): Result<string, { readonly _tag: "ConfigFileUnreadable"; readonly path: string; readonly cause: string }> {
    try {
      return ok(readFileSync(path, "utf-8"));
    } catch (cause) {
      return err({
        _tag: "ConfigFileUnreadable",
        path,
        cause: String(cause),
      });
    }
  },
};

interface LoadedBridgeInputs {
  readonly runtime: BridgeRuntimeConfig;
  readonly mergedEnv: Record<string, string | undefined>;
}

function loadBridgeInputs(configPath: string | undefined): Result<LoadedBridgeInputs, { readonly reason: string }> {
  const sourcePaths = deriveConfigSourcePaths(configPath);
  const rawFiles = readConfigFiles(sourcePaths, nodeDiskReader);
  if (rawFiles._tag === "Err") {
    return err({ reason: formatConfigError(rawFiles.error) });
  }

  const parsedEnv = rawFiles.value.envFileText === null
    ? ok(null)
    : parseEnvFile(rawFiles.value.envFileText);
  if (parsedEnv._tag === "Err") {
    return err({ reason: formatConfigError(parsedEnv.error) });
  }

  const mergedEnv = parsedEnv.value === null
    ? { ...process.env }
    : { ...process.env, ...parsedEnv.value.values };

  const runtimeEnv = resolveRuntimeEnv(process.env, parsedEnv.value);
  if (runtimeEnv._tag === "Err") {
    return err({ reason: formatConfigError(runtimeEnv.error) });
  }

  const projectDocument = rawFiles.value.projectConfigText === null || sourcePaths.projectConfigPath === null
    ? ok(null)
    : parseProjectConfig(sourcePaths.projectConfigPath, rawFiles.value.projectConfigText);
  if (projectDocument._tag === "Err") {
    return err({ reason: formatConfigError(projectDocument.error) });
  }

  const runtime = loadBridgeRuntimeConfig(runtimeEnv.value, parsedEnv.value, projectDocument.value);
  if (runtime._tag === "Err") {
    return err({ reason: formatConfigError(runtime.error) });
  }

  return ok({
    runtime: runtime.value,
    mergedEnv,
  });
}

function applyMergedEnv(mergedEnv: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value === undefined) continue;
    process.env[key] = value;
  }
}

function buildBridgeConfig(runtime: BridgeRuntimeConfig, mergedEnv: Record<string, string | undefined>): Result<BridgeConfig, { readonly reason: string }> {
  const moltzap = loadMoltzapRuntimeConfig(mergedEnv);
  if (moltzap._tag === "Err") {
    return err({ reason: moltzap.error.reason });
  }

  return ok({
    port: runtime.port,
    publicUrl: runtime.publicUrl,
    gatewayUrl: runtime.gatewayUrl,
    gatewaySecret: runtime.gatewaySecret,
    botUsername: runtime.botUsername,
    aoConfigPath: runtime.aoConfigPath ?? "",
    apiKey: runtime.apiKey,
    webhookSecret: runtime.webhookSecret,
    moltzap: moltzap.value,
    repos: buildRepos(runtime),
  });
}

function buildRepos(runtime: BridgeRuntimeConfig): ReadonlyMap<import("../src/types.ts").RepoFullName, RepoRoute> {
  const result = new Map<import("../src/types.ts").RepoFullName, RepoRoute>();
  for (const [repoFullName, entry] of runtime.routes) {
    result.set(asRepoFullName(repoFullName), {
      projectName: entry.projectName,
      webhookSecretEnvVar: entry.webhookSecretEnvVar,
      defaultBranch: entry.defaultBranch,
    });
  }
  return result;
}

function formatConfigError(error: { readonly _tag?: string; readonly reason?: string; readonly path?: string; readonly cause?: string; readonly key?: string; readonly raw?: string; readonly line?: string; readonly projectName?: string; readonly secretEnvVar?: string; readonly left?: string; readonly right?: string }): string {
  switch (error._tag) {
    case "MalformedEnvLine":
      return `Malformed .env line: ${error.line}`;
    case "MissingRequiredEnv":
      return `${error.key} is required.`;
    case "InvalidPort":
      return `Invalid ZAPBOT_PORT value: ${error.raw}`;
    case "SecretCollision":
      return `${error.left} must not equal ${error.right}.`;
    case "ConfigFileUnreadable":
      return `Cannot read config file ${error.path}: ${error.cause}`;
    case "ConfigFileInvalid":
      return `Invalid config file ${error.path}: ${error.cause}`;
    case "DeprecatedSecretBinding":
      return `Project ${error.projectName} uses deprecated webhook secret env var ${error.secretEnvVar}.`;
    case "ReloadRejected":
      return error.reason ?? "Config reload rejected.";
    default:
      return error.reason ?? "Unknown config error.";
  }
}

async function main() {
  const initialInputs = loadBridgeInputs(process.env.ZAPBOT_CONFIG);
  if (initialInputs._tag === "Err") {
    console.error(`[bridge] ${initialInputs.error.reason}`);
    process.exit(1);
  }

  applyMergedEnv(initialInputs.value.mergedEnv);

  const initialConfig = buildBridgeConfig(initialInputs.value.runtime, initialInputs.value.mergedEnv);
  if (initialConfig._tag === "Err") {
    console.error(`[bridge] ${initialConfig.error.reason}`);
    process.exit(1);
  }

  let liveRuntime = initialInputs.value.runtime;
  const cfg = initialConfig.value;
  log.info(`Webhook bridge starting on port ${cfg.port}`);

  const running = await startBridge(cfg);
  log.info(`Webhook bridge listening on ${cfg.publicUrl}`);

  let reloadInFlight = false;
  process.on("SIGHUP", () => {
    if (reloadInFlight) {
      log.warn("SIGHUP received while reload in flight; ignoring");
      return;
    }
    reloadInFlight = true;
    (async () => {
      try {
        const nextInputs = loadBridgeInputs(process.env.ZAPBOT_CONFIG);
        if (nextInputs._tag === "Err") {
          log.error(`Reload failed: ${nextInputs.error.reason}`);
          return;
        }

        const reloaded = reloadBridgeRuntimeConfig(liveRuntime, nextInputs.value.runtime);
        if (reloaded._tag === "Err") {
          log.error(`Reload failed: ${formatConfigError(reloaded.error)}`);
          return;
        }

        applyMergedEnv(nextInputs.value.mergedEnv);
        const nextConfig = buildBridgeConfig(reloaded.value.next, nextInputs.value.mergedEnv);
        if (nextConfig._tag === "Err") {
          log.error(`Reload failed: ${nextConfig.error.reason}`);
          return;
        }

        liveRuntime = reloaded.value.next;
        await running.reload(nextConfig.value);
        log.info(`Config reloaded (${nextConfig.value.repos.size} repos, secret rotated: ${reloaded.value.secretRotated})`);
      } catch (err) {
        log.error(`Reload failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        reloadInFlight = false;
      }
    })();
  });

  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutting down...");
    await running.stop();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error(`Fatal: ${err}`);
  process.exit(1);
});
