/**
 * Gateway authentication — GitHub API token verification with shared-secret fallback.
 *
 * Two auth methods:
 * 1. GitHub App installation token — verified by calling the GitHub API
 * 2. Shared secret (GATEWAY_SECRET) — simple PAT-mode for setups without a GitHub App
 */

import { timingSafeEqual } from "crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface AuthResult {
  valid: boolean;
  repos: string[];        // ["org/repo1", "org/repo2"] or ["*"] for shared-secret
  source: "github" | "shared-secret";
}

export interface AuthConfig {
  gatewaySecret?: string; // GATEWAY_SECRET for shared-secret auth
}

export interface AuthError {
  type: string;
  message: string;
  fix: string;
}

export type AuthOutcome =
  | { ok: true; result: AuthResult }
  | { ok: false; error: AuthError };

// ── Helpers ────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function authError(type: string, message: string, fix: string): AuthOutcome {
  return { ok: false, error: { type, message, fix } };
}

// ── GitHub token cache ─────────────────────────────────────────────

interface CacheEntry {
  result: AuthResult;
  expiresAt: number;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const tokenCache = new Map<string, CacheEntry>();

/** Clear the token cache — exposed for tests. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

/** Get current cache size — exposed for tests. */
export function getTokenCacheSize(): number {
  return tokenCache.size;
}

// ── GitHub token verification ──────────────────────────────────────

/**
 * Verify a GitHub App installation token by calling the GitHub API.
 *
 * Calls `GET https://api.github.com/installation/repositories` with the token.
 * - 200 = valid installation token; extract repo list
 * - 401 = invalid/expired token; reject
 *
 * Results are cached for 5 minutes to avoid hitting GitHub API on every heartbeat.
 */
export async function verifyGitHubToken(
  token: string,
): Promise<AuthOutcome> {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return { ok: true, result: cached.result };
  }

  // Evict expired entry if present
  if (cached) {
    tokenCache.delete(token);
  }

  try {
    const resp = await globalThis.fetch(
      "https://api.github.com/installation/repositories",
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "zapbot-gateway",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (resp.status === 401) {
      return authError(
        "invalid_token",
        "GitHub token is invalid or expired.",
        "Ensure you are sending a valid GitHub App installation token.",
      );
    }

    if (!resp.ok) {
      return authError(
        "github_api_error",
        `GitHub API returned ${resp.status}.`,
        "Check GitHub API status and try again.",
      );
    }

    const body = (await resp.json()) as {
      repositories?: Array<{ full_name: string }>;
    };

    const repos = (body.repositories || []).map((r) => r.full_name);

    const result: AuthResult = {
      valid: true,
      repos,
      source: "github",
    };

    // Cache the successful result
    tokenCache.set(token, {
      result,
      expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
    });

    return { ok: true, result };
  } catch {
    return authError(
      "github_api_error",
      "Failed to reach GitHub API for token verification.",
      "Check network connectivity and try again.",
    );
  }
}

// ── Shared-secret verification ─────────────────────────────────────

/**
 * Verify a shared secret (GATEWAY_SECRET).
 * Simple alternative for setups without a GitHub App.
 */
export function verifySharedSecret(
  token: string,
  secret: string,
): AuthOutcome {
  const tokenBuf = encoder.encode(token);
  const secretBuf = encoder.encode(secret);
  const secretsMatch =
    tokenBuf.length === secretBuf.length &&
    timingSafeEqual(tokenBuf, secretBuf);

  if (!secretsMatch) {
    return authError(
      "invalid_token",
      "Token verification failed.",
      "Check your GATEWAY_SECRET or use a valid GitHub App installation token.",
    );
  }

  return {
    ok: true,
    result: {
      valid: true,
      repos: ["*"],
      source: "shared-secret",
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Verify an incoming request's authentication.
 *
 * Flow:
 * 1. Extract Bearer token from Authorization header
 * 2. Try shared-secret check first (fast, no network)
 * 3. If not a shared secret, try GitHub token verification
 * 4. Return AuthResult on success, structured AuthError on failure
 */
export async function verifyRequest(
  req: Request,
  config: AuthConfig,
): Promise<AuthOutcome> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return authError(
      "missing_token",
      "No Authorization header provided.",
      "Include `Authorization: Bearer <token>` header.",
    );
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer" || !parts[1]) {
    return authError(
      "invalid_token_format",
      "Authorization header must be `Bearer <token>`.",
      "Check header format.",
    );
  }

  const token = parts[1];

  // Try shared-secret first (fast, no network call)
  if (config.gatewaySecret) {
    const secretResult = verifySharedSecret(token, config.gatewaySecret);
    if (secretResult.ok) {
      return secretResult;
    }
  }

  // Try GitHub token verification
  return verifyGitHubToken(token);
}

/**
 * Check if an auth result authorizes access to a specific repo.
 * Wildcard "*" (used by shared-secret auth) matches any repo.
 */
export function requireRepoAccess(
  result: AuthResult,
  repo: string,
): boolean {
  if (result.repos.includes("*")) return true;
  return result.repos.includes(repo);
}
