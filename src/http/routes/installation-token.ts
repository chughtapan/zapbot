/**
 * Token-broker endpoint: GET /api/tokens/installation
 *
 * Thin wrapper around the existing _authInstance singleton at
 * src/github/client.ts (getInstallationToken). No new mint path.
 *
 * Auth: Authorization: Bearer $ZAPBOT_API_KEY. Bearer match is constant-time
 * (timingSafeEqual). No JWT, no Supabase — this endpoint is local-only on the
 * bridge loopback listener.
 *
 * Invariants:
 *   - One mint path. All tokens originate from getInstallationToken().
 *   - No token written to disk. Handler holds the token in-memory only for
 *     the duration of the response.
 *   - `expires_at` is the real value returned by `@octokit/auth-app`, not a
 *     wall-clock guess. Propagating the truth lets downstream caches refresh
 *     at the actual GitHub expiry.
 *   - 409 app_not_configured when getInstallationToken() returns null
 *     (GITHUB_APP_ID or GITHUB_APP_INSTALLATION_ID unset).
 */

import { timingSafeEqual } from "node:crypto";
import { absurd } from "../../types.ts";

// ── Branded types ──────────────────────────────────────────────────

/** Opaque GitHub App installation token. Do not log, do not persist. */
export type InstallationToken = string & { readonly __brand: "InstallationToken" };

/** ISO-8601 timestamp. Narrower than raw string at public surface. */
export type Iso8601 = string & { readonly __brand: "Iso8601" };

// ── Response schema ────────────────────────────────────────────────

export interface InstallationTokenOk {
  readonly token: InstallationToken;
  readonly expires_at: Iso8601;
}

export type InstallationTokenError =
  | { readonly error: "unauthorized"; readonly message: string }
  | { readonly error: "app_not_configured"; readonly message: string }
  | { readonly error: "internal_error"; readonly message: string };

export type InstallationTokenResponse = InstallationTokenOk | InstallationTokenError;

export type InstallationTokenStatus =
  | { readonly status: 200; readonly body: InstallationTokenOk }
  | { readonly status: 401; readonly body: Extract<InstallationTokenError, { error: "unauthorized" }> }
  | { readonly status: 409; readonly body: Extract<InstallationTokenError, { error: "app_not_configured" }> }
  | { readonly status: 500; readonly body: Extract<InstallationTokenError, { error: "internal_error" }> };

// ── Handler dependencies ───────────────────────────────────────────

/**
 * Minted token + real GitHub App installation expiry (ISO-8601 UTC from
 * `@octokit/auth-app`). Callers at the bridge edge pass this through to the
 * broker response body.
 */
export interface MintedInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface InstallationTokenDeps {
  readonly mintToken: () => Promise<MintedInstallationToken | null>;
  readonly apiKey: string;
}

// ── Bearer auth middleware ─────────────────────────────────────────

const BEARER_PREFIX = "Bearer ";

function unauthorized(
  message: string,
): Extract<InstallationTokenError, { error: "unauthorized" }> {
  return { error: "unauthorized", message };
}

export function verifyBearer(
  authHeader: string | null,
  expected: string,
): null | Extract<InstallationTokenError, { error: "unauthorized" }> {
  if (authHeader === null || authHeader === "") {
    return unauthorized("Missing Authorization header.");
  }
  if (!authHeader.startsWith(BEARER_PREFIX)) {
    return unauthorized("Authorization header must use Bearer scheme.");
  }
  const provided = authHeader.slice(BEARER_PREFIX.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return unauthorized("Invalid Bearer credentials.");
  }
  return timingSafeEqual(a, b) ? null : unauthorized("Invalid Bearer credentials.");
}

// ── Handler ────────────────────────────────────────────────────────

export async function handleInstallationTokenRequest(
  req: Request,
  deps: InstallationTokenDeps,
): Promise<InstallationTokenStatus> {
  const authFailure = verifyBearer(req.headers.get("authorization"), deps.apiKey);
  if (authFailure !== null) {
    return { status: 401, body: authFailure };
  }

  let minted: MintedInstallationToken | null;
  try {
    minted = await deps.mintToken();
  } catch {
    // Exception body omitted on purpose — may include PEM fragments on misconfig.
    return {
      status: 500,
      body: { error: "internal_error", message: "Failed to mint installation token." },
    };
  }

  if (minted === null) {
    return {
      status: 409,
      body: {
        error: "app_not_configured",
        message:
          "GitHub App is not configured on the bridge (GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID required).",
      },
    };
  }

  const token = minted.token as InstallationToken;
  const expires_at = minted.expiresAt as Iso8601;
  return { status: 200, body: { token, expires_at } };
}

// ── Bun.serve adapter ──────────────────────────────────────────────

function toResponse(result: InstallationTokenStatus): Response {
  switch (result.status) {
    case 200:
      return Response.json(result.body, { status: 200 });
    case 401:
      return Response.json(result.body, { status: 401 });
    case 409:
      return Response.json(result.body, { status: 409 });
    case 500:
      return Response.json(result.body, { status: 500 });
    default:
      return absurd(result);
  }
}

export function installationTokenRoute(
  deps: InstallationTokenDeps,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const result = await handleInstallationTokenRequest(req, deps);
    const clientIp = req.headers.get("x-forwarded-for") ?? "local";
    console.log(
      JSON.stringify({
        event: "installation_token.request",
        status: result.status,
        client_ip: clientIp,
      }),
    );
    return toResponse(result);
  };
}
