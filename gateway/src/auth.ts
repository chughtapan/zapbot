/**
 * Gateway authentication — JWT verification with legacy shared-secret fallback.
 *
 * Uses the `jose` library for direct JWT verification with SUPABASE_JWT_SECRET.
 * No Supabase client SDK dependency — the gateway stays stateless.
 */

import { jwtVerify, errors as joseErrors } from "jose";
import { timingSafeEqual } from "crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface GatewayUser {
  sub: string;            // Supabase user ID (or "legacy" for shared-secret auth)
  email?: string;
  role: "owner" | "member";
  authorizedRepos: string[];  // ["org/repo1", "org/repo2"] or ["*"] for legacy
}

export interface AuthConfig {
  jwtSecret: string;              // SUPABASE_JWT_SECRET
  jwtIssuer?: string;             // Expected JWT issuer (Supabase project URL + /auth/v1)
  legacySecret?: string;          // GATEWAY_SECRET (backward compat)
  legacyEnabled: boolean;         // LEGACY_AUTH_ENABLED
  maxAgeSeconds: number;          // Max JWT age (default: 3600 = 1 hour)
}

export interface AuthError {
  type: string;
  message: string;
  fix: string;
}

export type AuthResult =
  | { ok: true; user: GatewayUser }
  | { ok: false; error: AuthError };

// ── Helpers ────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Track whether we've logged the legacy deprecation warning this startup. */
let legacyDeprecationLogged = false;

/** Reset the deprecation flag — exposed for tests. */
export function resetLegacyDeprecationFlag(): void {
  legacyDeprecationLogged = false;
}

function authError(type: string, message: string, fix: string): AuthResult {
  return { ok: false, error: { type, message, fix } };
}

// ── JWT verification ───────────────────────────────────────────────

interface SupabaseJwtPayload {
  sub?: string;
  email?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  app_metadata?: {
    role?: string;
    authorized_repos?: string[];
  };
}

async function verifyJwt(
  token: string,
  config: AuthConfig,
): Promise<AuthResult> {
  const secret = encoder.encode(config.jwtSecret);

  let payload: SupabaseJwtPayload;
  try {
    const result = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      ...(config.jwtIssuer ? { issuer: config.jwtIssuer } : {}),
      audience: "authenticated",
    });
    payload = result.payload as SupabaseJwtPayload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return authError(
        "token_expired",
        `Token expired at ${err.payload?.exp ? new Date((err.payload.exp as number) * 1000).toISOString() : "unknown"}`,
        "Refresh your Supabase JWT.",
      );
    }
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return authError(
        "invalid_signature",
        "Token signature verification failed.",
        "Verify SUPABASE_JWT_SECRET matches your Supabase project.",
      );
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      const claim = err.claim || "unknown";
      if (claim === "iss") {
        return authError(
          "invalid_issuer",
          "Token issuer does not match expected.",
          "Check SUPABASE_URL configuration.",
        );
      }
      if (claim === "aud") {
        return authError(
          "invalid_audience",
          "Token audience does not match expected.",
          'Ensure your Supabase JWT has audience "authenticated".',
        );
      }
      return authError(
        "invalid_claims",
        `JWT claim validation failed: ${claim}`,
        "Check your Supabase JWT configuration.",
      );
    }
    return authError(
      "invalid_token",
      "Token verification failed.",
      "Ensure you are sending a valid Supabase JWT.",
    );
  }

  // Check max age (iat must be within maxAgeSeconds)
  if (payload.iat === undefined || payload.iat === null) {
    return authError(
      "missing_claims",
      "Token missing required claim: iat",
      "Ensure your Supabase JWT includes an issued-at (iat) claim.",
    );
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = nowSeconds - payload.iat;
  if (age > config.maxAgeSeconds) {
    return authError(
      "token_too_old",
      `Token issued more than ${config.maxAgeSeconds} seconds ago.`,
      "Obtain a fresh JWT.",
    );
  }

  // Extract and validate claims
  if (!payload.sub) {
    return authError(
      "missing_claims",
      "Token missing required claim: sub",
      "Ensure your Supabase JWT includes a subject claim.",
    );
  }

  const appMeta = payload.app_metadata;
  const role = appMeta?.role;
  if (role !== "owner" && role !== "member") {
    return authError(
      "missing_claims",
      "Token missing required claim: app_metadata.role (must be 'owner' or 'member')",
      "Set app_metadata.role in Supabase.",
    );
  }

  const authorizedRepos = appMeta?.authorized_repos;
  if (!Array.isArray(authorizedRepos) || authorizedRepos.length === 0) {
    return authError(
      "missing_claims",
      "Token missing required claim: app_metadata.authorized_repos",
      "Set app_metadata.authorized_repos in Supabase.",
    );
  }

  return {
    ok: true,
    user: {
      sub: payload.sub,
      email: payload.email,
      role,
      authorizedRepos,
    },
  };
}

// ── Legacy shared-secret verification ──────────────────────────────

function verifyLegacy(token: string, config: AuthConfig): AuthResult {
  if (!config.legacyEnabled) {
    return authError(
      "invalid_token",
      "Legacy shared-secret auth is disabled.",
      "Use a Supabase JWT for authentication.",
    );
  }
  if (!config.legacySecret) {
    return authError(
      "invalid_token",
      "Token verification failed.",
      "Ensure you are sending a valid Supabase JWT.",
    );
  }

  const tokenBuf = encoder.encode(token);
  const secretBuf = encoder.encode(config.legacySecret);
  const secretsMatch =
    tokenBuf.length === secretBuf.length &&
    timingSafeEqual(tokenBuf, secretBuf);
  if (!secretsMatch) {
    return authError(
      "invalid_token",
      "Token verification failed.",
      "Check your GATEWAY_SECRET or use a valid Supabase JWT.",
    );
  }

  // Log deprecation warning once per startup
  if (!legacyDeprecationLogged) {
    console.warn(
      "[gateway] DEPRECATION: Legacy shared-secret auth used. Migrate to Supabase JWT. " +
      "Set LEGACY_AUTH_ENABLED=false after migrating all bridges.",
    );
    legacyDeprecationLogged = true;
  }

  return {
    ok: true,
    user: {
      sub: "legacy",
      role: "owner",
      authorizedRepos: ["*"],
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Verify an incoming request's authentication.
 *
 * Flow:
 * 1. Extract Bearer token from Authorization header
 * 2. Try JWT verification first
 * 3. If JWT fails and legacy auth is enabled, try shared-secret check
 * 4. Return GatewayUser on success, structured AuthError on failure
 */
export async function verifyRequest(
  req: Request,
  config: AuthConfig,
): Promise<AuthResult> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    return authError(
      "missing_token",
      "No Authorization header provided.",
      "Include `Authorization: Bearer <jwt>` header.",
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

  // Try JWT verification first (if jwtSecret is configured)
  if (config.jwtSecret) {
    const jwtResult = await verifyJwt(token, config);
    if (jwtResult.ok) {
      return jwtResult;
    }

    // JWT failed — try legacy if enabled
    if (config.legacyEnabled && config.legacySecret) {
      const legacyResult = verifyLegacy(token, config);
      if (legacyResult.ok) {
        return legacyResult;
      }
    }

    // Return the JWT error (more informative than legacy error)
    return jwtResult;
  }

  // No JWT secret configured — only legacy auth available
  return verifyLegacy(token, config);
}

/**
 * Check if a user has the required role.
 * Owners satisfy both "owner" and "member" requirements.
 */
export function requireRole(
  user: GatewayUser,
  role: "owner" | "member",
): boolean {
  if (role === "member") return true; // Both owner and member satisfy "member"
  return user.role === "owner";
}

/**
 * Check if a user is authorized for a specific repo.
 * Wildcard "*" (used by legacy auth) matches any repo.
 */
export function requireRepoAccess(
  user: GatewayUser,
  repo: string,
): boolean {
  if (user.authorizedRepos.includes("*")) return true;
  if (user.authorizedRepos.includes(repo)) return true;

  // Check org-level wildcard: if user has "org" authorized, it matches "org/any-repo"
  const repoOrg = repo.split("/")[0];
  if (repoOrg && user.authorizedRepos.includes(repoOrg)) return true;

  return false;
}
