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

/** Register or update a bridge for a given repo. */
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

/** Remove a bridge registration for a repo. */
export function deregisterBridge(repo: string): boolean {
  return bridges.delete(repo);
}

/** Look up the active bridge for a repo. Returns undefined if none or inactive. */
export function getBridge(repo: string): BridgeEntry | undefined {
  const entry = bridges.get(repo);
  if (!entry || !entry.active) return undefined;
  return entry;
}

/** Get all registered bridges (including inactive). */
export function getAllBridges(): BridgeEntry[] {
  return Array.from(bridges.values());
}

/** Mark a bridge as seen (updates lastSeen timestamp). */
export function touchBridge(repo: string): void {
  const entry = bridges.get(repo);
  if (entry) {
    entry.lastSeen = Date.now();
    entry.active = true;
  }
}

/**
 * Mark bridges as inactive if they haven't been seen within the timeout.
 * Returns the list of repos that were marked inactive.
 */
export function sweepStaleBridges(timeoutMs: number): string[] {
  const now = Date.now();
  const swept: string[] = [];
  for (const [repo, entry] of bridges) {
    if (entry.active && now - entry.lastSeen > timeoutMs) {
      entry.active = false;
      swept.push(repo);
    }
  }
  return swept;
}

/** Clear all registrations (useful for tests). */
export function clearRegistry(): void {
  bridges.clear();
}
