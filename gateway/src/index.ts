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
import type { AuthConfig } from "./auth.js";

// ── Config ──────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8080", 10);
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";
const LEGACY_AUTH_ENABLED = process.env.LEGACY_AUTH_ENABLED !== "false";
const JWT_MAX_AGE_SECONDS = parseInt(process.env.JWT_MAX_AGE_SECONDS || "3600", 10);
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

if (!SUPABASE_JWT_SECRET && !GATEWAY_SECRET) {
  log("error", "Either SUPABASE_JWT_SECRET or GATEWAY_SECRET must be set.");
  process.exit(1);
}

if (!SUPABASE_JWT_SECRET) {
  log("warn", "SUPABASE_JWT_SECRET not set. Only legacy auth available.");
}

if (GATEWAY_SECRET && LEGACY_AUTH_ENABLED) {
  log("warn", "Legacy auth enabled. Set LEGACY_AUTH_ENABLED=false after migrating bridges to JWT.");
}

log("info", "Auth config", {
  jwt_enabled: !!SUPABASE_JWT_SECRET,
  legacy_enabled: LEGACY_AUTH_ENABLED && !!GATEWAY_SECRET,
  max_age_s: JWT_MAX_AGE_SECONDS,
});

// ── Auth config ────────────────────────────────────────────────────

const authConfig: AuthConfig = {
  jwtSecret: SUPABASE_JWT_SECRET,
  jwtIssuer: SUPABASE_URL ? `${SUPABASE_URL}/auth/v1` : undefined,
  legacySecret: GATEWAY_SECRET || undefined,
  legacyEnabled: LEGACY_AUTH_ENABLED,
  maxAgeSeconds: JWT_MAX_AGE_SECONDS,
};

// ── Server ──────────────────────────────────────────────────────────

const handler = createFetchHandler({
  authConfig,
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
