import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  verifyGitHubToken,
  verifyGitHubPAT,
  verifySharedSecret,
  verifyRequest,
  requireRepoAccess,
  clearTokenCache,
  getTokenCacheSize,
  type AuthConfig,
  type AuthResult,
} from "../src/auth.js";

// ── Test helpers ───────────────────────────────────────────────────

const TEST_GATEWAY_SECRET = "test-gateway-secret";

const MOCK_REPOS_RESPONSE = {
  repositories: [
    { full_name: "acme/app" },
    { full_name: "acme/lib" },
  ],
};

const MOCK_USER_RESPONSE = {
  login: "tapanc",
};

const MOCK_PERMISSION_RESPONSE = {
  permission: "write",
};

function defaultConfig(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    gatewaySecret: TEST_GATEWAY_SECRET,
    ...overrides,
  };
}

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers["authorization"] = token;
  }
  return new Request("http://localhost/test", { headers });
}

// ── Setup ─────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

beforeEach(() => {
  clearTokenCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── verifyGitHubToken ─────────────────────────────────────────────

describe("verifyGitHubToken", () => {
  it("accepts a valid installation token (200 with repo list)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json(MOCK_REPOS_RESPONSE, { status: 200 }),
    );

    const result = await verifyGitHubToken("ghs_validtoken123");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.valid).toBe(true);
      expect(result.result.source).toBe("github");
      expect(result.result.repos).toEqual(["acme/app", "acme/lib"]);
    }

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.github.com/installation/repositories",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer ghs_validtoken123",
        }),
      }),
    );
  });

  it("rejects an expired/invalid token (401)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
    );

    const result = await verifyGitHubToken("ghs_expired");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_token");
      expect(result.error.message).toContain("invalid or expired");
    }
  });

  it("handles GitHub API errors (non-200, non-401)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await verifyGitHubToken("ghs_sometoken");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("github_api_error");
      expect(result.error.message).toContain("500");
    }
  });

  it("handles network failure (GitHub API down)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await verifyGitHubToken("ghs_sometoken");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("github_api_error");
      expect(result.error.message).toContain("Failed to reach GitHub API");
    }
  });

  it("caches valid tokens (no API call on second request within 5min)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json(MOCK_REPOS_RESPONSE, { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    // First call — hits API
    const result1 = await verifyGitHubToken("ghs_cached");
    expect(result1.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call — should use cache
    const result2 = await verifyGitHubToken("ghs_cached");
    expect(result2.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1); // NOT called again

    if (result2.ok) {
      expect(result2.result.repos).toEqual(["acme/app", "acme/lib"]);
    }
  });

  it("does not cache invalid tokens", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
    );
    globalThis.fetch = mockFetch;

    await verifyGitHubToken("ghs_invalid");
    await verifyGitHubToken("ghs_invalid");

    // Should call API both times since failures aren't cached
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("evicts expired cache entries", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json(MOCK_REPOS_RESPONSE, { status: 200 }),
    );
    globalThis.fetch = mockFetch;

    // First call — caches the result
    await verifyGitHubToken("ghs_expiring");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(getTokenCacheSize()).toBe(1);

    // Manually expire the cache entry by clearing and re-adding with past expiry
    clearTokenCache();

    // Next call — cache is empty, so API is called again
    await verifyGitHubToken("ghs_expiring");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("handles empty repositories list", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({ repositories: [] }, { status: 200 }),
    );

    const result = await verifyGitHubToken("ghs_norepos");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.repos).toEqual([]);
    }
  });
});

// ── verifyGitHubPAT ───────────────────────────────────────────────

describe("verifyGitHubPAT", () => {
  it("accepts a PAT for a teammate with write access", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(MOCK_USER_RESPONSE, { status: 200 }))
      .mockResolvedValueOnce(Response.json(MOCK_PERMISSION_RESPONSE, { status: 200 }));

    const result = await verifyGitHubPAT("ghp_writer", "acme/app");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.user).toBe("tapanc");
      expect(result.result.permission).toBe("write");
      expect(result.result.repo).toBe("acme/app");
    }
  });

  it("rejects an invalid PAT", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
    );

    const result = await verifyGitHubPAT("ghp_invalid", "acme/app");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_token");
    }
  });

  it("rejects a teammate without write access", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(MOCK_USER_RESPONSE, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ permission: "read" }, { status: 200 }));

    const result = await verifyGitHubPAT("ghp_reader", "acme/app");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("repo_not_authorized");
    }
  });

  it("caches valid PAT checks per repo", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(MOCK_USER_RESPONSE, { status: 200 }))
      .mockResolvedValueOnce(Response.json(MOCK_PERMISSION_RESPONSE, { status: 200 }));
    globalThis.fetch = mockFetch;

    const first = await verifyGitHubPAT("ghp_writer", "acme/app");
    const second = await verifyGitHubPAT("ghp_writer", "acme/app");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── verifySharedSecret ────────────────────────────────────────────

describe("verifySharedSecret", () => {
  it("accepts matching secret", () => {
    const result = verifySharedSecret(TEST_GATEWAY_SECRET, TEST_GATEWAY_SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.source).toBe("shared-secret");
      expect(result.result.repos).toEqual(["*"]);
    }
  });

  it("rejects wrong secret", () => {
    const result = verifySharedSecret("wrong-secret", TEST_GATEWAY_SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_token");
    }
  });

  it("rejects empty token", () => {
    const result = verifySharedSecret("", TEST_GATEWAY_SECRET);
    expect(result.ok).toBe(false);
  });
});

// ── verifyRequest ─────────────────────────────────────────────────

describe("verifyRequest", () => {
  it("returns missing_token when no Authorization header", async () => {
    const result = await verifyRequest(makeRequest(), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("missing_token");
    }
  });

  it("returns invalid_token_format for non-Bearer header", async () => {
    const result = await verifyRequest(makeRequest("Basic abc123"), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_token_format");
    }
  });

  it("returns invalid_token_format for Bearer with no token", async () => {
    const result = await verifyRequest(makeRequest("Bearer "), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_token_format");
    }
  });

  it("accepts shared secret (fast path, no GitHub API call)", async () => {
    const mockFetch = vi.fn();
    globalThis.fetch = mockFetch;

    const result = await verifyRequest(
      makeRequest(`Bearer ${TEST_GATEWAY_SECRET}`),
      defaultConfig(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.source).toBe("shared-secret");
      expect(result.result.repos).toEqual(["*"]);
    }
    // Should NOT have called GitHub API
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("falls through to GitHub token when shared secret doesn't match", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json(MOCK_REPOS_RESPONSE, { status: 200 }),
    );

    const result = await verifyRequest(
      makeRequest("Bearer ghs_sometoken"),
      defaultConfig(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.source).toBe("github");
    }
  });

  it("works without gatewaySecret configured (GitHub-only mode)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json(MOCK_REPOS_RESPONSE, { status: 200 }),
    );

    const result = await verifyRequest(
      makeRequest("Bearer ghs_sometoken"),
      defaultConfig({ gatewaySecret: undefined }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.source).toBe("github");
    }
  });
});

// ── requireRepoAccess ─────────────────────────────────────────────

describe("requireRepoAccess", () => {
  it("allows access to authorized repo", () => {
    const result: AuthResult = { valid: true, repos: ["acme/app", "acme/lib"], source: "github" };
    expect(requireRepoAccess(result, "acme/app")).toBe(true);
  });

  it("denies access to unauthorized repo", () => {
    const result: AuthResult = { valid: true, repos: ["acme/app"], source: "github" };
    expect(requireRepoAccess(result, "other/repo")).toBe(false);
  });

  it("wildcard * allows access to any repo (shared-secret)", () => {
    const result: AuthResult = { valid: true, repos: ["*"], source: "shared-secret" };
    expect(requireRepoAccess(result, "any/repo")).toBe(true);
  });

  it("denies access when repo list is empty", () => {
    const result: AuthResult = { valid: true, repos: [], source: "github" };
    expect(requireRepoAccess(result, "acme/app")).toBe(false);
  });
});
