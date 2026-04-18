/**
 * Token-broker endpoint: GET /api/tokens/installation
 *
 * Thin wrapper around the existing _authInstance singleton at
 * src/github/client.ts:200-218 (getInstallationToken). No new mint path.
 *
 * Auth: Authorization: Bearer $ZAPBOT_API_KEY. Bearer match is constant-time
 * (timingSafeEqual). No JWT, no Supabase — this endpoint is local-only on the
 * bridge loopback listener.
 *
 * Invariants enforced here (contract; implementation lands downstream):
 *   - One mint path. All tokens originate from getInstallationToken().
 *   - No token written to disk. Handler holds the token in-memory only for
 *     the duration of the response.
 *   - 409 app_not_configured when getInstallationToken() returns null
 *     (GITHUB_APP_ID or GITHUB_APP_INSTALLATION_ID unset).
 *
 * Interfaces only. Every function body is `throw new Error("not implemented")`.
 * Implementation is a downstream task.
 */

// ── Branded types ──────────────────────────────────────────────────

/** Opaque GitHub App installation token. Do not log, do not persist. */
export type InstallationToken = string & { readonly __brand: "InstallationToken" };

/** ISO-8601 timestamp. Narrower than raw string at public surface. */
export type Iso8601 = string & { readonly __brand: "Iso8601" };

// ── Response schema ────────────────────────────────────────────────

/**
 * 200 body. `expires_at` is informational only; callers MUST NOT cache.
 * Invariant 1 of spec #15: no caller-side cache. Architect-flagged:
 * safer-publish likely ignores `expires_at`; field stays in the response
 * shape because removal is breaking.
 */
export interface InstallationTokenOk {
  readonly token: InstallationToken;
  readonly expires_at: Iso8601;
}

/**
 * 4xx / 5xx body. Discriminated on `error` tag so callers can exhaust branches
 * at the type level rather than string-matching.
 */
export type InstallationTokenError =
  | { readonly error: "unauthorized"; readonly message: string }
  | { readonly error: "app_not_configured"; readonly message: string }
  | { readonly error: "internal_error"; readonly message: string };

export type InstallationTokenResponse = InstallationTokenOk | InstallationTokenError;

/** Response-code contract, exhaustive over the above union. */
export type InstallationTokenStatus =
  | { readonly status: 200; readonly body: InstallationTokenOk }
  | { readonly status: 401; readonly body: Extract<InstallationTokenError, { error: "unauthorized" }> }
  | { readonly status: 409; readonly body: Extract<InstallationTokenError, { error: "app_not_configured" }> }
  | { readonly status: 500; readonly body: Extract<InstallationTokenError, { error: "internal_error" }> };

// ── Handler dependencies ───────────────────────────────────────────

/**
 * Dependency shape for the handler. Injection (rather than module-scope
 * imports) keeps the handler testable without bringing up the full bridge.
 *
 * `mintToken` MUST be the existing getInstallationToken function from
 * src/github/client.ts. A `null` return signals app-not-configured.
 * `apiKey` is read once at bridge boot from process.env.ZAPBOT_API_KEY;
 * missing/empty key at boot is a bridge-level configuration failure and
 * never reaches this handler.
 */
export interface InstallationTokenDeps {
  readonly mintToken: () => Promise<string | null>;
  readonly apiKey: string;
  readonly now: () => Date;
}

// ── Handler ────────────────────────────────────────────────────────

/**
 * Decides the response for a single GET /api/tokens/installation request.
 *
 * Contract:
 *   - If Authorization header is missing, malformed, or does not constant-time
 *     match `deps.apiKey`, return 401 unauthorized.
 *   - Else call `deps.mintToken()`. Null → 409 app_not_configured.
 *   - Else return 200 with `{ token, expires_at }`. `expires_at` is derived
 *     from the library's cached auth metadata; a conservative default of
 *     `now + 1h` is acceptable if the library exposes no hook (documented
 *     in spec §4 invariant 3: library handles refresh).
 *   - Any thrown exception from `mintToken` becomes 500 internal_error.
 *     The message MUST NOT include the exception body (may leak PEM
 *     fragments on misconfig).
 */
export function handleInstallationTokenRequest(
  req: Request,
  deps: InstallationTokenDeps,
): Promise<InstallationTokenStatus> {
  throw new Error("not implemented");
}

/**
 * Bun.serve fetch-handler adapter. Wires handleInstallationTokenRequest
 * into the bridge's existing pathname switch at bin/webhook-bridge.ts.
 * Wrap-only; no logic. Emits a structured log line per call (no token
 * value; only status + client-ip).
 */
export function installationTokenRoute(
  deps: InstallationTokenDeps,
): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}

// ── Bearer auth middleware ─────────────────────────────────────────

/**
 * Constant-time Bearer-token check. Extracted so the webhook routes can
 * adopt it uniformly in a follow-up (today, /api/workflows and /api/tokens
 * use ad-hoc string equality). Returns null on pass, the 401 body on fail.
 */
export function verifyBearer(
  authHeader: string | null,
  expected: string,
): null | Extract<InstallationTokenError, { error: "unauthorized" }> {
  throw new Error("not implemented");
}
