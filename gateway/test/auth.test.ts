import { describe, it, expect, beforeEach } from "vitest";
import { SignJWT } from "jose";
import {
  verifyRequest,
  requireRole,
  requireRepoAccess,
  resetLegacyDeprecationFlag,
  type AuthConfig,
  type GatewayUser,
} from "../src/auth.js";

// ── Test helpers ───────────────────────────────────────────────────

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars-long!!";
const TEST_LEGACY_SECRET = "test-legacy-secret";
const TEST_ISSUER = "https://test.supabase.co/auth/v1";
const encoder = new TextEncoder();

function defaultConfig(overrides?: Partial<AuthConfig>): AuthConfig {
  return {
    jwtSecret: TEST_JWT_SECRET,
    jwtIssuer: TEST_ISSUER,
    legacySecret: TEST_LEGACY_SECRET,
    legacyEnabled: true,
    maxAgeSeconds: 3600,
    ...overrides,
  };
}

async function createTestJWT(
  claims: Record<string, unknown> = {},
  options?: { expiresIn?: string; iat?: number; skipIat?: boolean; secret?: string; issuer?: string; audience?: string },
): Promise<string> {
  const secret = options?.secret || TEST_JWT_SECRET;
  const builder = new SignJWT({
    sub: "user-uuid-123",
    email: "test@example.com",
    app_metadata: {
      role: "owner",
      authorized_repos: ["acme/app", "acme/lib"],
    },
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(options?.issuer ?? TEST_ISSUER)
    .setAudience(options?.audience ?? "authenticated")
    .setExpirationTime(options?.expiresIn || "1h");

  if (options?.skipIat) {
    // Don't set iat at all
  } else if (options?.iat !== undefined) {
    builder.setIssuedAt(options.iat);
  } else {
    builder.setIssuedAt();
  }

  return builder.sign(encoder.encode(secret));
}

function makeRequest(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers["authorization"] = token;
  }
  return new Request("http://localhost/test", { headers });
}

// ── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  resetLegacyDeprecationFlag();
});

describe("verifyRequest", () => {
  // ── Missing/malformed auth header ────────────────────────────────

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

  // ── Valid JWT ────────────────────────────────────────────────────

  it("accepts a valid owner JWT", async () => {
    const jwt = await createTestJWT();
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.sub).toBe("user-uuid-123");
      expect(result.user.email).toBe("test@example.com");
      expect(result.user.role).toBe("owner");
      expect(result.user.authorizedRepos).toEqual(["acme/app", "acme/lib"]);
    }
  });

  it("accepts a valid member JWT", async () => {
    const jwt = await createTestJWT({
      app_metadata: { role: "member", authorized_repos: ["acme/app"] },
    });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.role).toBe("member");
    }
  });

  // ── Expired JWT ──────────────────────────────────────────────────

  it("rejects an expired JWT", async () => {
    const jwt = await createTestJWT({}, { expiresIn: "-1h" });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("token_expired");
    }
  });

  // ── Invalid signature ────────────────────────────────────────────

  it("rejects a JWT signed with wrong secret", async () => {
    const jwt = await createTestJWT({}, { secret: "wrong-secret-that-is-at-least-32-chars!" });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_signature");
    }
  });

  // ── Wrong issuer ─────────────────────────────────────────────────

  it("rejects a JWT with wrong issuer", async () => {
    const jwt = await createTestJWT({}, { issuer: "https://wrong.supabase.co/auth/v1" });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_issuer");
    }
  });

  // ── Wrong audience ───────────────────────────────────────────────

  it("rejects a JWT with wrong audience", async () => {
    const jwt = await createTestJWT({}, { audience: "wrong-audience" });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("invalid_audience");
    }
  });

  // ── Token too old ────────────────────────────────────────────────

  it("rejects a JWT that is too old (iat check)", async () => {
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200;
    const jwt = await createTestJWT({}, { iat: twoHoursAgo });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("token_too_old");
    }
  });

  // ── Missing iat ─────────────────────────────────────────────────

  it("rejects a JWT without iat claim", async () => {
    const jwt = await createTestJWT({}, { skipIat: true });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("missing_claims");
      expect(result.error.message).toContain("iat");
    }
  });

  // ── Missing claims ───────────────────────────────────────────────

  it("rejects JWT without sub claim", async () => {
    const jwt = await createTestJWT({ sub: undefined });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("missing_claims");
      expect(result.error.message).toContain("sub");
    }
  });

  it("rejects JWT without app_metadata.role", async () => {
    const jwt = await createTestJWT({
      app_metadata: { authorized_repos: ["acme/app"] },
    });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("missing_claims");
      expect(result.error.message).toContain("role");
    }
  });

  it("rejects JWT without app_metadata.authorized_repos", async () => {
    const jwt = await createTestJWT({
      app_metadata: { role: "owner" },
    });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("missing_claims");
      expect(result.error.message).toContain("authorized_repos");
    }
  });

  it("rejects JWT with empty authorized_repos array", async () => {
    const jwt = await createTestJWT({
      app_metadata: { role: "owner", authorized_repos: [] },
    });
    const result = await verifyRequest(makeRequest(`Bearer ${jwt}`), defaultConfig());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe("missing_claims");
    }
  });

  // ── Legacy auth ──────────────────────────────────────────────────

  it("accepts legacy secret when enabled", async () => {
    const result = await verifyRequest(
      makeRequest(`Bearer ${TEST_LEGACY_SECRET}`),
      defaultConfig(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.sub).toBe("legacy");
      expect(result.user.role).toBe("owner");
      expect(result.user.authorizedRepos).toEqual(["*"]);
    }
  });

  it("rejects wrong legacy secret", async () => {
    const result = await verifyRequest(
      makeRequest("Bearer wrong-secret"),
      defaultConfig(),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects legacy secret when disabled", async () => {
    const result = await verifyRequest(
      makeRequest(`Bearer ${TEST_LEGACY_SECRET}`),
      defaultConfig({ legacyEnabled: false }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts legacy secret when jwtSecret is empty", async () => {
    const result = await verifyRequest(
      makeRequest(`Bearer ${TEST_LEGACY_SECRET}`),
      defaultConfig({ jwtSecret: "" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user.sub).toBe("legacy");
    }
  });

  // ── Issuer not configured ────────────────────────────────────────

  it("accepts JWT when jwtIssuer is not configured (skip issuer check)", async () => {
    const jwt = await createTestJWT({}, { issuer: "https://any-issuer.supabase.co/auth/v1" });
    const result = await verifyRequest(
      makeRequest(`Bearer ${jwt}`),
      defaultConfig({ jwtIssuer: undefined }),
    );
    expect(result.ok).toBe(true);
  });
});

// ── Role checks ────────────────────────────────────────────────────

describe("requireRole", () => {
  const owner: GatewayUser = { sub: "u1", role: "owner", authorizedRepos: ["acme/app"] };
  const member: GatewayUser = { sub: "u2", role: "member", authorizedRepos: ["acme/app"] };

  it("owner satisfies owner requirement", () => {
    expect(requireRole(owner, "owner")).toBe(true);
  });

  it("owner satisfies member requirement", () => {
    expect(requireRole(owner, "member")).toBe(true);
  });

  it("member satisfies member requirement", () => {
    expect(requireRole(member, "member")).toBe(true);
  });

  it("member does not satisfy owner requirement", () => {
    expect(requireRole(member, "owner")).toBe(false);
  });
});

// ── Repo access checks ────────────────────────────────────────────

describe("requireRepoAccess", () => {
  it("allows access to authorized repo", () => {
    const user: GatewayUser = { sub: "u1", role: "owner", authorizedRepos: ["acme/app"] };
    expect(requireRepoAccess(user, "acme/app")).toBe(true);
  });

  it("denies access to unauthorized repo", () => {
    const user: GatewayUser = { sub: "u1", role: "owner", authorizedRepos: ["acme/app"] };
    expect(requireRepoAccess(user, "other/repo")).toBe(false);
  });

  it("wildcard * allows access to any repo", () => {
    const user: GatewayUser = { sub: "legacy", role: "owner", authorizedRepos: ["*"] };
    expect(requireRepoAccess(user, "any/repo")).toBe(true);
  });

  it("org-level access allows any repo in that org", () => {
    const user: GatewayUser = { sub: "u1", role: "owner", authorizedRepos: ["acme"] };
    expect(requireRepoAccess(user, "acme/app")).toBe(true);
    expect(requireRepoAccess(user, "acme/lib")).toBe(true);
    expect(requireRepoAccess(user, "other/repo")).toBe(false);
  });
});
