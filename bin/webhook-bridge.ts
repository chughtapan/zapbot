/**
 * bin/webhook-bridge — entrypoint.
 *
 * v1's bridge carried the HTTP server, HMAC verify, mention dispatch,
 * state-machine engine, SQLite store, plannotator callbacks, and recovery.
 * v2 moves the live code into `v2/bridge.ts`; this file is only the CLI
 * shim that reads config, boots the server, and wires signals.
 */

import { loadConfig, type RepoMap } from "../src/config/loader.js";
import { reloadConfigFromDisk } from "../src/config/reload.js";
import { createLogger } from "../src/logger.js";
import { startBridge, type BridgeConfig, type RepoRoute } from "../v2/bridge.ts";
import {
  asBotUsername,
  asProjectName,
  asRepoFullName,
} from "../v2/types.ts";

process.on("unhandledRejection", (err) => {
  console.error("[bridge] Unhandled rejection (non-fatal):", err instanceof Error ? err.message : err);
});

const log = createLogger("bridge");

function buildBridgeConfig(): BridgeConfig {
  const port = parseInt(process.env.ZAPBOT_PORT || "3000", 10);
  const publicUrl = process.env.ZAPBOT_BRIDGE_URL || `http://localhost:${port}`;
  const gatewayUrl = process.env.ZAPBOT_GATEWAY_URL || "";
  const gatewaySecret = process.env.ZAPBOT_GATEWAY_SECRET || null;
  const botUsername = asBotUsername(process.env.ZAPBOT_BOT_USERNAME || "zapbot[bot]");
  const aoConfigPath = process.env.ZAPBOT_CONFIG || "";

  const apiKey = process.env.ZAPBOT_API_KEY;
  if (!apiKey) {
    console.error("[bridge] ZAPBOT_API_KEY is required. Set it in .env or export it.");
    process.exit(1);
  }
  const webhookSecret = process.env.ZAPBOT_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error(
      "[bridge] ZAPBOT_WEBHOOK_SECRET is required (distinct from ZAPBOT_API_KEY). " +
        "Generate with `openssl rand -hex 32` and set in .env."
    );
    process.exit(1);
  }
  if (webhookSecret === apiKey) {
    console.error(
      "[bridge] ZAPBOT_WEBHOOK_SECRET must not equal ZAPBOT_API_KEY. " +
        "The webhook HMAC secret and the broker bearer key must be distinct."
    );
    process.exit(1);
  }

  const { repoMap } = loadConfig(process.env.ZAPBOT_CONFIG || undefined);
  const repos = buildRepos(repoMap);
  return {
    port,
    publicUrl,
    gatewayUrl,
    gatewaySecret,
    botUsername,
    aoConfigPath,
    apiKey,
    webhookSecret,
    repos,
  };
}

function buildRepos(repoMap: RepoMap): ReadonlyMap<import("../v2/types.ts").RepoFullName, RepoRoute> {
  const result = new Map<import("../v2/types.ts").RepoFullName, RepoRoute>();
  for (const [repoFullName, entry] of repoMap) {
    result.set(asRepoFullName(repoFullName), {
      projectName: asProjectName(entry.projectName),
      webhookSecretEnvVar: entry.config.scm?.webhook?.secretEnvVar || "ZAPBOT_WEBHOOK_SECRET",
      defaultBranch: entry.config.defaultBranch || "main",
    });
  }
  return result;
}

async function main() {
  const cfg = buildBridgeConfig();
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
        const envPath = process.env.ZAPBOT_CONFIG?.replace(/agent-orchestrator\.yaml$/, ".env");
        const result = reloadConfigFromDisk(envPath, process.env.ZAPBOT_CONFIG, process.env.ZAPBOT_WEBHOOK_SECRET!);
        if (!result) return;
        const next = buildBridgeConfig();
        await running.reload(next);
        log.info(`Config reloaded (${next.repos.size} repos)`);
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
