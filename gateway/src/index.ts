/**
 * Zapbot Gateway — entry point.
 *
 * Starts the Bun HTTP server, liveness sweep, and graceful shutdown.
 * The route handler lives in handler.ts for testability.
 */

import {
  getAllBridges,
  touchBridge,
  sweepStaleBridges,
} from "./registry.js";
import { createFetchHandler } from "./handler.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";
const LIVENESS_INTERVAL_MS = parseInt(process.env.LIVENESS_INTERVAL_MS || "30000", 10);
const STALE_TIMEOUT_MS = parseInt(process.env.STALE_TIMEOUT_MS || "60000", 10);
const FORWARD_TIMEOUT_MS = parseInt(process.env.FORWARD_TIMEOUT_MS || "30000", 10);

// ── Logging ─────────────────────────────────────────────────────────

function log(level: string, message: string, kv: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  const kvStr = Object.entries(kv)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  const line = `${timestamp} ${level.toUpperCase().padEnd(5)} [gateway] ${message}${kvStr ? ` (${kvStr})` : ""}`;
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(line + "\n");
}

// ── Startup validation ──────────────────────────────────────────────

if (!GATEWAY_SECRET) {
  log("error", "GATEWAY_SECRET is not set — bridge registration will be rejected. Set this env var before deploying.");
  process.exit(1);
}

// ── Server ──────────────────────────────────────────────────────────

const handler = createFetchHandler({
  gatewaySecret: GATEWAY_SECRET,
  forwardTimeoutMs: FORWARD_TIMEOUT_MS,
});

const server = Bun.serve({ port: PORT, fetch: handler });

// ── Bridge liveness sweep ───────────────────────────────────────────

let livenessTimer: ReturnType<typeof setInterval> | null = null;

function startLivenessSweep(): void {
  livenessTimer = setInterval(async () => {
    const activeBridges = getAllBridges().filter((b) => b.active);
    if (activeBridges.length === 0) return;

    // Ping all bridges concurrently to avoid serial timeout accumulation
    await Promise.allSettled(
      activeBridges.map(async (bridge) => {
        try {
          const resp = await fetch(`${bridge.bridgeUrl}/healthz`, {
            signal: AbortSignal.timeout(5000),
          });
          if (resp.ok) {
            touchBridge(bridge.repo);
          }
        } catch {
          log("debug", `Liveness ping failed for ${bridge.repo}`);
        }
      }),
    );

    const swept = sweepStaleBridges(STALE_TIMEOUT_MS);
    if (swept.length > 0) {
      log("warn", `Swept stale bridges: ${swept.join(", ")}`);
    }
  }, LIVENESS_INTERVAL_MS);
}

startLivenessSweep();

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(signal: string): void {
  log("info", `Received ${signal}, shutting down`);
  if (livenessTimer) clearInterval(livenessTimer);
  server.stop();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

log("info", `Gateway listening on port ${PORT}`);

export { server };
