/**
 * bin/webhook-bridge — entrypoint.
 *
 * v1's bridge carried the HTTP server, HMAC verify, mention dispatch,
 * state-machine engine, SQLite store, plannotator callbacks, and recovery.
 * The live runtime now sits under `src/`; this file is only the CLI shim
 * that reads config, boots the server, and wires signals.
 *
 * Shared secrets (apiKey, webhookSecret) load from `~/.zapbot/config.json`
 * via `readCanonicalConfig`. No `.env` parsing. Port and ingress knobs
 * continue to read from `process.env` directly.
 */

import { readFileSync } from "fs";
import {
  deriveConfigSourcePaths,
  loadBridgeRuntimeConfig,
} from "../src/config/load.ts";
import { resolveRuntimeEnv } from "../src/config/env.ts";
import { readCanonicalConfig } from "../src/config/canonical.ts";
import { resolveIngressPolicy } from "../src/config/ingress.ts";
import { parseProjectConfig, readConfigFiles } from "../src/config/disk.ts";
import { reloadBridgeRuntimeConfig } from "../src/config/reload.ts";
import type {
  BridgeRuntimeConfig,
  ConfigDiskError,
  ConfigReloadError,
} from "../src/config/types.ts";
import type { IngressResolutionError } from "../src/config/ingress.ts";
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
  readText(path: string): Result<string, ConfigDiskError> {
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

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}

async function probeHealthz(publicUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${publicUrl.replace(/\/+$/u, "")}/healthz`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function loadBridgeInputs(
  configPath: string | undefined,
  isPublicUrlReachable: (publicUrl: string) => Promise<boolean> = probeHealthz,
): Promise<Result<BridgeRuntimeConfig, { readonly reason: string }>> {
  const sourcePaths = deriveConfigSourcePaths(configPath);

  const canonical = readCanonicalConfig(sourcePaths.canonicalConfigPath, nodeDiskReader);
  if (canonical._tag === "Err") {
    return err({ reason: formatConfigError(canonical.error) });
  }

  const rawFiles = readConfigFiles(sourcePaths, nodeDiskReader);
  if (rawFiles._tag === "Err") {
    return err({ reason: formatConfigError(rawFiles.error) });
  }

  const runtimeEnv = resolveRuntimeEnv(process.env, canonical.value);
  if (runtimeEnv._tag === "Err") {
    return err({ reason: formatConfigError(runtimeEnv.error) });
  }

  const ingressMode = runtimeEnv.value.gatewayUrl === null ? "local-only" : "github-demo";
  const ingress = await resolveIngressPolicy({
    mode: ingressMode,
    gatewayUrl: runtimeEnv.value.gatewayUrl ?? "",
    publicUrl: runtimeEnv.value.publicUrl,
    isPublicUrlReachable,
  });
  if (ingress._tag === "Err") {
    return err({ reason: formatIngressError(ingress.error) });
  }

  const projectDocument = rawFiles.value.projectConfigText === null || sourcePaths.projectConfigPath === null
    ? ok(null)
    : parseProjectConfig(sourcePaths.projectConfigPath, rawFiles.value.projectConfigText);
  if (projectDocument._tag === "Err") {
    return err({ reason: formatConfigError(projectDocument.error) });
  }

  const runtime = loadBridgeRuntimeConfig(runtimeEnv.value, projectDocument.value, ingress.value);
  if (runtime._tag === "Err") {
    return err({ reason: formatConfigError(runtime.error) });
  }

  return ok(runtime.value);
}

function buildBridgeConfig(runtime: BridgeRuntimeConfig): Result<BridgeConfig, { readonly reason: string }> {
  const moltzap = loadMoltzapRuntimeConfig(process.env);
  if (moltzap._tag === "Err") {
    return err({ reason: moltzap.error.reason });
  }

  return ok({
    port: runtime.port,
    ingress: runtime.ingress,
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

function formatConfigError(error: ConfigReloadError): string {
  switch (error._tag) {
    case "InvalidPort":
      return `Invalid ZAPBOT_PORT value: ${error.raw}`;
    case "SecretCollision":
      return `${error.left} must not equal ${error.right}.`;
    case "ConfigFileUnreadable":
      return `Cannot read config file ${error.path}: ${error.cause}`;
    case "ConfigFileInvalid":
      return `Invalid config file ${error.path}: ${error.cause}`;
    case "CanonicalConfigMissing":
      return `Canonical config not found at ${error.path}. Run zapbot-team-init to create it.`;
    case "CanonicalConfigInvalid":
      return `Invalid canonical config at ${error.path}: ${error.cause}`;
    case "DeprecatedSecretBinding":
      return `Project ${error.projectName} uses deprecated webhook secret env var ${error.secretEnvVar}.`;
    case "ReloadRejected":
      return error.reason;
    default:
      return absurd(error);
  }
}

function formatIngressError(error: IngressResolutionError): string {
  switch (error._tag) {
    case "InvalidIngressMode":
      return `Unsupported ingress mode: ${error.mode}`;
    case "MissingPublicBridgeUrl":
      return "ZAPBOT_BRIDGE_URL is required in GitHub demo mode.";
    case "UnreachablePublicBridgeUrl":
      return `ZAPBOT_BRIDGE_URL is unreachable: ${error.publicUrl}`;
    case "DemoModeRequiresGateway":
      return "ZAPBOT_GATEWAY_URL is required in GitHub demo mode.";
    default:
      return absurd(error);
  }
}

async function main() {
  // Skip the reachability probe on initial load — the bridge isn't running yet
  // so /healthz isn't open. We boot first, then probe the live endpoint below.
  const initialInputs = await loadBridgeInputs(process.env.ZAPBOT_CONFIG, async () => true);
  if (initialInputs._tag === "Err") {
    console.error(`[bridge] ${initialInputs.error.reason}`);
    process.exit(1);
  }

  const initialConfig = buildBridgeConfig(initialInputs.value);
  if (initialConfig._tag === "Err") {
    console.error(`[bridge] ${initialConfig.error.reason}`);
    process.exit(1);
  }

  let liveRuntime = initialInputs.value;
  const cfg = initialConfig.value;
  log.info(`Webhook bridge starting on port ${cfg.port}`);
  log.info(`Ingress mode: ${cfg.ingress.mode}`);

  const running = await startBridge(cfg);

  // Post-boot reachability probe — fires against the now-live /healthz endpoint.
  // If the probe fails, tear down the bridge cleanly before exiting.
  if (cfg.ingress.mode === "github-demo" && cfg.publicUrl !== null) {
    const reachable = await probeHealthz(cfg.publicUrl);
    if (!reachable) {
      await running.stop();
      console.error(`[bridge] ZAPBOT_BRIDGE_URL is unreachable: ${cfg.publicUrl}`);
      process.exit(1);
    }
  }

  log.info(`Webhook bridge listening on ${cfg.ingress.mode === "github-demo" ? cfg.publicUrl : "local-only ingress"}`);

  let reloadInFlight = false;
  process.on("SIGHUP", () => {
    if (reloadInFlight) {
      log.warn("SIGHUP received while reload in flight; ignoring");
      return;
    }
    reloadInFlight = true;
    (async () => {
      try {
        const nextInputs = await loadBridgeInputs(process.env.ZAPBOT_CONFIG, probeHealthz);
        if (nextInputs._tag === "Err") {
          log.error(`Reload failed: ${nextInputs.error.reason}`);
          return;
        }

        const reloaded = reloadBridgeRuntimeConfig(liveRuntime, nextInputs.value);
        if (reloaded._tag === "Err") {
          log.error(`Reload failed: ${formatConfigError(reloaded.error)}`);
          return;
        }

        const nextConfig = buildBridgeConfig(reloaded.value.next);
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
