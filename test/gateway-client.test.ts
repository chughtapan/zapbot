import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { SignJWT } from "jose";
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
import { resetLegacyDeprecationFlag, type AuthConfig } from "../gateway/src/auth.js";

/**
 * Tests for the gateway client module (src/gateway/client.ts).
 *
 * Spins up a real gateway handler so we test registration, deregistration,
 * and heartbeat end-to-end without mocking HTTP.
 */

const LEGACY_SECRET = "test-secret-abc123";
const JWT_SECRET = "test-jwt-secret-at-least-32-chars-long!!";
const JWT_ISSUER = "https://test.supabase.co/auth/v1";
const encoder = new TextEncoder();

const authConfig: AuthConfig = {
  jwtSecret: JWT_SECRET,
  jwtIssuer: JWT_ISSUER,
  legacySecret: LEGACY_SECRET,
  legacyEnabled: true,
  maxAgeSeconds: 3600,
};

async function createOwnerJWT(): Promise<string> {
  return new SignJWT({
    sub: "user-uuid-123",
    email: "test@example.com",
    app_metadata: {
      role: "owner",
      authorized_repos: ["owner/repo", "owner/repo-a", "owner/repo-b", "owner/a", "owner/b"],
    },
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(encoder.encode(JWT_SECRET));
}

let gatewayServer: ReturnType<typeof Bun.serve>;
let gatewayUrl: string;
let legacyConfig: GatewayClientConfig;

beforeAll(() => {
  const handler = createFetchHandler({
    authConfig,
    forwardTimeoutMs: 5000,
  });
  gatewayServer = Bun.serve({ port: 0, fetch: handler });
  gatewayUrl = `http://localhost:${gatewayServer.port}`;
  legacyConfig = { gatewayUrl, secret: LEGACY_SECRET };
});

afterAll(() => {
  gatewayServer.stop(true);
});

beforeEach(() => {
  clearRegistry();
  resetLegacyDeprecationFlag();
});

afterEach(() => {
  stopHeartbeats();
});

describe("gateway client", () => {
  describe("registerBridge", () => {
    it("registers a bridge with legacy secret", async () => {
      await registerBridge(legacyConfig, "owner/repo", "http://localhost:3000");
      const bridge = getBridge("owner/repo");
      expect(bridge).toBeDefined();
      expect(bridge!.bridgeUrl).toBe("http://localhost:3000");
      expect(bridge!.active).toBe(true);
    });

    it("registers a bridge with JWT token", async () => {
      const jwt = await createOwnerJWT();
      const jwtConfig: GatewayClientConfig = { gatewayUrl, token: jwt };
      await registerBridge(jwtConfig, "owner/repo", "http://localhost:3000");
      const bridge = getBridge("owner/repo");
      expect(bridge).toBeDefined();
      expect(bridge!.bridgeUrl).toBe("http://localhost:3000");
    });

    it("JWT token takes precedence over legacy secret", async () => {
      const jwt = await createOwnerJWT();
      const config: GatewayClientConfig = { gatewayUrl, token: jwt, secret: "wrong-secret" };
      // Should succeed because JWT is used, not the wrong legacy secret
      await registerBridge(config, "owner/repo", "http://localhost:3000");
      expect(getBridge("owner/repo")).toBeDefined();
    });

    it("registers multiple repos", async () => {
      await registerBridge(legacyConfig, "owner/repo-a", "http://localhost:3000");
      await registerBridge(legacyConfig, "owner/repo-b", "http://localhost:3000");
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
      await registerBridge(legacyConfig, "owner/repo", "http://localhost:3000");
      expect(getBridge("owner/repo")).toBeDefined();

      await deregisterBridge(legacyConfig, "owner/repo");
      expect(getBridge("owner/repo")).toBeUndefined();
    });

    it("does not throw for non-existent repo", async () => {
      // Deregistering a repo that doesn't exist should not throw
      await deregisterBridge(legacyConfig, "owner/nonexistent");
    });
  });

  describe("heartbeat", () => {
    it("re-registers to update lastSeen", async () => {
      await registerBridge(legacyConfig, "owner/repo", "http://localhost:3000");
      const firstSeen = getBridge("owner/repo")!.lastSeen;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      await heartbeat(legacyConfig, "owner/repo", "http://localhost:3000");

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

    it("works with JWT token", async () => {
      const jwt = await createOwnerJWT();
      const jwtConfig: GatewayClientConfig = { gatewayUrl, token: jwt };
      await registerBridge(jwtConfig, "owner/repo", "http://localhost:3000");
      const firstSeen = getBridge("owner/repo")!.lastSeen;

      await new Promise((r) => setTimeout(r, 10));
      await heartbeat(jwtConfig, "owner/repo", "http://localhost:3000");

      const secondSeen = getBridge("owner/repo")!.lastSeen;
      expect(secondSeen).toBeGreaterThanOrEqual(firstSeen);
    });
  });

  describe("setupGateway", () => {
    it("registers all repos and returns cleanup function", async () => {
      const cleanup = await setupGateway(legacyConfig, ["owner/a", "owner/b"], "http://localhost:3000");

      expect(getBridge("owner/a")).toBeDefined();
      expect(getBridge("owner/b")).toBeDefined();

      await cleanup();
      expect(getBridge("owner/a")).toBeUndefined();
      expect(getBridge("owner/b")).toBeUndefined();
    });
  });
});
