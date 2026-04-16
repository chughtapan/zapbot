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
import { clearTokenCache, type AuthConfig } from "../gateway/src/auth.js";

/**
 * Tests for the gateway client module (src/gateway/client.ts).
 *
 * Spins up a real gateway handler so we test registration, deregistration,
 * and heartbeat end-to-end without mocking HTTP.
 *
 * Uses a fetch mock to intercept GitHub API calls while letting
 * localhost requests pass through to the real test servers.
 */

const SHARED_SECRET = "test-secret-abc123";
const GITHUB_TOKEN = "ghs_test_installation_token";

const MOCK_REPOS_RESPONSE = {
  repositories: [
    { full_name: "owner/repo" },
    { full_name: "owner/repo-a" },
    { full_name: "owner/repo-b" },
    { full_name: "owner/a" },
    { full_name: "owner/b" },
  ],
};

const authConfig: AuthConfig = {
  gatewaySecret: SHARED_SECRET,
};

const originalFetch = globalThis.fetch;

/**
 * Install a fetch mock that intercepts GitHub API calls and passes
 * through all other requests to the real fetch implementation.
 */
function installFetchMock() {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("api.github.com")) {
      const headers = init?.headers as Record<string, string> | undefined;
      const authHeader =
        (headers && (headers["Authorization"] || headers["authorization"])) ||
        (input instanceof Request ? input.headers.get("authorization") : undefined);

      if (authHeader === `Bearer ${GITHUB_TOKEN}`) {
        return Response.json(MOCK_REPOS_RESPONSE, { status: 200 });
      }
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    }
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
}

let gatewayServer: ReturnType<typeof Bun.serve>;
let gatewayUrl: string;
let sharedSecretConfig: GatewayClientConfig;

beforeAll(() => {
  const handler = createFetchHandler({
    authConfig,
    forwardTimeoutMs: 5000,
  });
  gatewayServer = Bun.serve({ port: 0, fetch: handler });
  gatewayUrl = `http://localhost:${gatewayServer.port}`;
  sharedSecretConfig = { gatewayUrl, secret: SHARED_SECRET };
});

afterAll(() => {
  gatewayServer.stop(true);
});

beforeEach(() => {
  clearRegistry();
  clearTokenCache();
  installFetchMock();
});

afterEach(() => {
  stopHeartbeats();
  globalThis.fetch = originalFetch;
});

describe("gateway client", () => {
  describe("registerBridge", () => {
    it("registers a bridge with shared secret", async () => {
      await registerBridge(sharedSecretConfig, "owner/repo", "http://localhost:3000");
      const bridge = getBridge("owner/repo");
      expect(bridge).toBeDefined();
      expect(bridge!.bridgeUrl).toBe("http://localhost:3000");
      expect(bridge!.active).toBe(true);
    });

    it("registers a bridge with GitHub token", async () => {
      const githubConfig: GatewayClientConfig = { gatewayUrl, token: GITHUB_TOKEN };
      await registerBridge(githubConfig, "owner/repo", "http://localhost:3000");
      const bridge = getBridge("owner/repo");
      expect(bridge).toBeDefined();
      expect(bridge!.bridgeUrl).toBe("http://localhost:3000");
    });

    it("token takes precedence over secret", async () => {
      const config: GatewayClientConfig = { gatewayUrl, token: GITHUB_TOKEN, secret: "wrong-secret" };
      // Should succeed because token is used, not the wrong secret
      await registerBridge(config, "owner/repo", "http://localhost:3000");
      expect(getBridge("owner/repo")).toBeDefined();
    });

    it("registers multiple repos", async () => {
      await registerBridge(sharedSecretConfig, "owner/repo-a", "http://localhost:3000");
      await registerBridge(sharedSecretConfig, "owner/repo-b", "http://localhost:3000");
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
      await registerBridge(sharedSecretConfig, "owner/repo", "http://localhost:3000");
      expect(getBridge("owner/repo")).toBeDefined();

      await deregisterBridge(sharedSecretConfig, "owner/repo");
      expect(getBridge("owner/repo")).toBeUndefined();
    });

    it("does not throw for non-existent repo", async () => {
      // Deregistering a repo that doesn't exist should not throw
      await deregisterBridge(sharedSecretConfig, "owner/nonexistent");
    });
  });

  describe("heartbeat", () => {
    it("re-registers to update lastSeen", async () => {
      await registerBridge(sharedSecretConfig, "owner/repo", "http://localhost:3000");
      const firstSeen = getBridge("owner/repo")!.lastSeen;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));
      await heartbeat(sharedSecretConfig, "owner/repo", "http://localhost:3000");

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

    it("works with GitHub token", async () => {
      const githubConfig: GatewayClientConfig = { gatewayUrl, token: GITHUB_TOKEN };
      await registerBridge(githubConfig, "owner/repo", "http://localhost:3000");
      const firstSeen = getBridge("owner/repo")!.lastSeen;

      await new Promise((r) => setTimeout(r, 10));
      await heartbeat(githubConfig, "owner/repo", "http://localhost:3000");

      const secondSeen = getBridge("owner/repo")!.lastSeen;
      expect(secondSeen).toBeGreaterThanOrEqual(firstSeen);
    });
  });

  describe("setupGateway", () => {
    it("registers all repos and returns cleanup function", async () => {
      const cleanup = await setupGateway(sharedSecretConfig, ["owner/a", "owner/b"], "http://localhost:3000");

      expect(getBridge("owner/a")).toBeDefined();
      expect(getBridge("owner/b")).toBeDefined();

      await cleanup();
      expect(getBridge("owner/a")).toBeUndefined();
      expect(getBridge("owner/b")).toBeUndefined();
    });
  });
});
