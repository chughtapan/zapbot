import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import {
  registerBridge,
  deregisterBridge,
  heartbeat,
  setupGateway,
  stopHeartbeats,
  type GatewayClientConfig,
} from "../src/gateway/client.js";
import { createFetchHandler } from "../gateway/src/handler.js";
import { clearRegistry, getBridge } from "../gateway/src/registry.js";

/**
 * Tests for the gateway client module (src/gateway/client.ts).
 *
 * Spins up a real gateway handler so we test registration, deregistration,
 * and heartbeat end-to-end without mocking HTTP.
 */

const GATEWAY_SECRET = "test-secret-abc123";

let gatewayServer: ReturnType<typeof Bun.serve>;
let gatewayUrl: string;
let config: GatewayClientConfig;

beforeAll(() => {
  const handler = createFetchHandler({
    gatewaySecret: GATEWAY_SECRET,
    forwardTimeoutMs: 5000,
  });
  gatewayServer = Bun.serve({ port: 0, fetch: handler });
  gatewayUrl = `http://localhost:${gatewayServer.port}`;
  config = { gatewayUrl, secret: GATEWAY_SECRET };
});

afterAll(() => {
  gatewayServer.stop(true);
});

beforeEach(() => {
  clearRegistry();
});

afterEach(() => {
  stopHeartbeats();
});

describe("gateway client", () => {
  describe("registerBridge", () => {
    it("registers a bridge with the gateway", async () => {
      await registerBridge(config, "owner/repo", "http://localhost:3000");
      const bridge = getBridge("owner/repo");
      expect(bridge).toBeDefined();
      expect(bridge!.bridgeUrl).toBe("http://localhost:3000");
      expect(bridge!.active).toBe(true);
    });

    it("registers multiple repos", async () => {
      await registerBridge(config, "owner/repo-a", "http://localhost:3000");
      await registerBridge(config, "owner/repo-b", "http://localhost:3000");
      expect(getBridge("owner/repo-a")).toBeDefined();
      expect(getBridge("owner/repo-b")).toBeDefined();
    });

    it("throws on invalid secret", async () => {
      const badConfig = { gatewayUrl, secret: "wrong-secret" };
      await expect(registerBridge(badConfig, "owner/repo", "http://localhost:3000"))
        .rejects.toThrow();
    });
  });

  describe("deregisterBridge", () => {
    it("removes a bridge from the gateway", async () => {
      await registerBridge(config, "owner/repo", "http://localhost:3000");
      expect(getBridge("owner/repo")).toBeDefined();

      await deregisterBridge(config, "owner/repo");
      expect(getBridge("owner/repo")).toBeUndefined();
    });

    it("does not throw for non-existent repo", async () => {
      // Deregistering a repo that doesn't exist should not throw
      await deregisterBridge(config, "owner/nonexistent");
    });
  });

  describe("heartbeat", () => {
    it("re-registers to update lastSeen", async () => {
      await registerBridge(config, "owner/repo", "http://localhost:3000");
      const firstSeen = getBridge("owner/repo")!.lastSeen;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      await heartbeat(config, "owner/repo", "http://localhost:3000");

      const secondSeen = getBridge("owner/repo")!.lastSeen;
      expect(secondSeen).toBeGreaterThanOrEqual(firstSeen);
    });

    it("does not throw on auth failure", async () => {
      // Use a reachable URL with bad credentials — avoids retry backoff on connection errors
      const badConfig = { gatewayUrl, secret: "wrong-secret" };
      // heartbeat swallows errors (registerBridge throws on auth failure, heartbeat catches it)
      await heartbeat(badConfig, "owner/repo", "http://localhost:3000");
      // Should not have registered
      expect(getBridge("owner/repo")).toBeUndefined();
    });
  });

  describe("setupGateway", () => {
    it("registers all repos and returns cleanup function", async () => {
      const cleanup = await setupGateway(config, ["owner/a", "owner/b"], "http://localhost:3000");

      expect(getBridge("owner/a")).toBeDefined();
      expect(getBridge("owner/b")).toBeDefined();

      await cleanup();
      expect(getBridge("owner/a")).toBeUndefined();
      expect(getBridge("owner/b")).toBeUndefined();
    });
  });
});
