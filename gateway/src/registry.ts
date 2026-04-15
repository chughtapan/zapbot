/**
 * In-memory registry of bridge instances.
 *
 * Each bridge registers with a repo name and its public URL.
 * The gateway uses this to route incoming GitHub webhooks to the
 * correct bridge. Bridges are expected to re-register periodically
 * (or respond to liveness pings) to stay active.
 */

export interface BridgeEntry {
  repo: string;
  bridgeUrl: string;
  registeredAt: number;
  lastSeen: number;
  active: boolean;
}

const bridges = new Map<string, BridgeEntry>();

export function registerBridge(repo: string, bridgeUrl: string): BridgeEntry {
  const now = Date.now();
  const entry: BridgeEntry = {
    repo,
    bridgeUrl,
    registeredAt: bridges.get(repo)?.registeredAt ?? now,
    lastSeen: now,
    active: true,
  };
  bridges.set(repo, entry);
  return entry;
}

export function deregisterBridge(repo: string): boolean {
  return bridges.delete(repo);
}

/** Returns undefined if no bridge is registered or if the bridge is inactive. */
export function getBridge(repo: string): BridgeEntry | undefined {
  const entry = bridges.get(repo);
  if (!entry || !entry.active) return undefined;
  return entry;
}

export function getAllBridges(): BridgeEntry[] {
  return Array.from(bridges.values());
}

export function touchBridge(repo: string): void {
  const entry = bridges.get(repo);
  if (entry) {
    entry.lastSeen = Date.now();
    entry.active = true;
  }
}

/**
 * Mark bridges as inactive if they haven't been seen within the timeout.
 * Reap (delete) bridges that have been inactive for 5x the timeout to
 * prevent unbounded memory growth from crashed bridges.
 * Returns the list of repos that were newly marked inactive.
 */
export function sweepStaleBridges(timeoutMs: number): string[] {
  const now = Date.now();
  const swept: string[] = [];
  const reapThreshold = timeoutMs * 5;
  for (const [repo, entry] of bridges) {
    if (!entry.active && now - entry.lastSeen > reapThreshold) {
      bridges.delete(repo);
    } else if (entry.active && now - entry.lastSeen > timeoutMs) {
      entry.active = false;
      swept.push(repo);
    }
  }
  return swept;
}

export function clearRegistry(): void {
  bridges.clear();
}
