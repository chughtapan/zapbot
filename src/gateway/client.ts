/**
 * Gateway client — registers/deregisters this bridge with the Railway gateway.
 *
 * The gateway forwards GitHub webhooks to registered bridges. On startup the
 * bridge registers its public URL; on shutdown it deregisters. A periodic
 * heartbeat (re-registration) keeps the entry fresh so the gateway's liveness
 * sweep doesn't mark it stale.
 */

import { createLogger } from "../logger.js";

const log = createLogger("gateway-client");

// ── Retry helper ───────────────────────────────────────────────────

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  { retries = 3, baseDelayMs = 1000 }: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok || resp.status < 500) return resp;
      lastError = new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) {
      const delay = baseDelayMs * 2 ** attempt;
      log.warn(`Gateway request failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms`, {
        url,
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ── Public API ─────────────────────────────────────────────────────

export interface GatewayClientConfig {
  gatewayUrl: string;
  secret?: string;      // ZAPBOT_GATEWAY_SECRET (shared secret)
  token?: string;       // GitHub App installation token
}

function getAuthToken(config: GatewayClientConfig): string {
  return config.token || config.secret || "";
}

/**
 * Register this bridge with the gateway for a given repo.
 * The gateway will forward webhooks for `repo` to `bridgeUrl`.
 */
export async function registerBridge(
  config: GatewayClientConfig,
  repo: string,
  bridgeUrl: string,
): Promise<void> {
  const url = `${config.gatewayUrl}/api/bridges/register`;
  const resp = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAuthToken(config)}`,
    },
    body: JSON.stringify({ repo, bridgeUrl }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gateway registration failed for ${repo}: HTTP ${resp.status} — ${body}`);
  }

  log.info(`Registered with gateway: ${repo} → ${bridgeUrl}`, { repo, bridgeUrl });
}

/**
 * Deregister this bridge from the gateway for a given repo.
 * Called on graceful shutdown.
 */
export async function deregisterBridge(
  config: GatewayClientConfig,
  repo: string,
): Promise<void> {
  const url = `${config.gatewayUrl}/api/bridges/register`;
  try {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAuthToken(config)}`,
      },
      body: JSON.stringify({ repo }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!resp.ok) {
      log.warn(`Gateway deregistration failed for ${repo}: HTTP ${resp.status}`, { repo });
      return;
    }

    log.info(`Deregistered from gateway: ${repo}`, { repo });
  } catch (err) {
    // Best-effort on shutdown — don't block exit
    log.warn(`Gateway deregistration error for ${repo}: ${err}`, { repo });
  }
}

/**
 * Heartbeat — re-registers with the gateway to update `lastSeen`.
 * The gateway's liveness sweep marks bridges stale after STALE_TIMEOUT_MS
 * (default 60s), so heartbeats should run more frequently than that.
 */
export async function heartbeat(
  config: GatewayClientConfig,
  repo: string,
  bridgeUrl: string,
): Promise<void> {
  try {
    await registerBridge(config, repo, bridgeUrl);
  } catch (err) {
    log.warn(`Heartbeat failed for ${repo}: ${err}`, { repo });
  }
}

// ── Heartbeat manager ──────────────────────────────────────────────

const heartbeatTimers: ReturnType<typeof setInterval>[] = [];

/**
 * Start periodic heartbeats for all registered repos.
 * Default interval is 30s (half the gateway's default 60s stale timeout).
 */
export function startHeartbeats(
  config: GatewayClientConfig,
  repos: string[],
  bridgeUrl: string,
  intervalMs = 30_000,
): void {
  if (heartbeatTimers.length > 0) stopHeartbeats();
  for (const repo of repos) {
    const timer = setInterval(() => heartbeat(config, repo, bridgeUrl), intervalMs);
    heartbeatTimers.push(timer);
  }
  log.info(`Started gateway heartbeats for ${repos.length} repo(s) every ${intervalMs}ms`);
}

/**
 * Stop all heartbeat timers. Called on shutdown.
 */
export function stopHeartbeats(): void {
  for (const timer of heartbeatTimers) {
    clearInterval(timer);
  }
  heartbeatTimers.length = 0;
}

/**
 * Register all repos with the gateway and start heartbeats.
 * Returns a cleanup function that deregisters all repos and stops heartbeats.
 */
export async function setupGateway(
  config: GatewayClientConfig,
  repos: string[],
  bridgeUrl: string,
): Promise<() => Promise<void>> {
  // Register all repos
  for (const repo of repos) {
    await registerBridge(config, repo, bridgeUrl);
  }

  // Start periodic heartbeats (default 5min to keep Render free tier awake)
  const intervalMs = parseInt(process.env.ZAPBOT_GATEWAY_HEARTBEAT_MS || "300000", 10);
  startHeartbeats(config, repos, bridgeUrl, intervalMs);

  // Return cleanup function
  return async () => {
    stopHeartbeats();
    await Promise.allSettled(
      repos.map((repo) => deregisterBridge(config, repo)),
    );
  };
}
