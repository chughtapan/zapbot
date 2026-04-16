<!-- /autoplan restore point: /home/tapanc/.gstack/projects/chughtapan-zapbot/feat-issue-48-autoplan-restore-20260415-214452.md -->
# Plan: Gateway Authentication with Supabase

**Issue:** #48 — Gateway authentication with Supabase
**Parent:** #44 — Migrate to github bot + auth + railway
**Branch:** feat/issue-48
**Status:** REVIEWED

## Problem

The gateway currently uses a shared `GATEWAY_SECRET` for all authentication. Every bridge operator uses the same Bearer token. There's no per-user identity, no authorization scoping, and no way to know WHO registered a bridge or controls a workflow. For a multi-user, multi-team orchestration system, this is a non-starter.

## Goal

Replace shared-secret auth with Supabase JWT-based authentication. Each user gets their own identity. Bridge registration, workflow access, and admin operations are scoped by role (owner vs member) and by org/repo.

## What Exists Today

### Gateway (Railway-deployed)
- `gateway/src/handler.ts` — Pure fetch handler. `verifyAuth()` checks `Bearer ${GATEWAY_SECRET}`. Used by register/deregister endpoints.
- `gateway/src/index.ts` — Server startup. Validates `GATEWAY_SECRET` on boot, exits if missing.
- `gateway/src/registry.ts` — In-memory bridge registry. `registerBridge()`, `getBridge()`, `sweepStaleBridges()`. No auth awareness.
- `gateway/.env.example` — Only has `GATEWAY_SECRET`.

### Bridge Client (local)
- `src/gateway/client.ts` — `GatewayClientConfig` with `{ gatewayUrl, secret }`. Sends `Authorization: Bearer ${secret}` on register/deregister/heartbeat.
- `bin/webhook-bridge.ts` — Reads `ZAPBOT_GATEWAY_URL`, `ZAPBOT_GATEWAY_SECRET`, `ZAPBOT_BRIDGE_URL` from env.

### Tests
- `gateway/test/gateway-endpoints.test.ts` — 14 tests covering health, register, deregister, webhook forwarding. All use `TEST_SECRET` as the shared secret.
- `test/gateway-client.test.ts` — 5 tests covering client register/deregister/heartbeat/setup.

## Approach

### JWT Verification (not Supabase client SDK)

Use the `jose` library for direct JWT verification with `SUPABASE_JWT_SECRET`. This avoids a runtime dependency on `@supabase/supabase-js` in the gateway, keeps the gateway stateless, and is faster (no network calls to Supabase on each request).

The gateway needs to:
1. Verify the JWT signature (HS256)
2. Check expiration AND max age (reject JWTs with `iat` > 1 hour old)
3. Validate issuer and audience claims
4. Extract claims (sub, email, role, authorized repos)

### Access Control

Two roles:
- **owner** — can register/deregister bridges, view all workflows, manage users
- **member** — can view workflows for authorized repos

Authorization data lives in Supabase (the `authorized_users` table with RLS). The gateway doesn't query Supabase on every request. Instead, authorized repos/orgs are encoded as custom claims in the JWT (set via Supabase's `app_metadata` or a custom hook). The gateway verifies the JWT and reads claims locally.

JWT claim structure:
```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "iss": "https://<project>.supabase.co/auth/v1",
  "aud": "authenticated",
  "app_metadata": {
    "role": "owner",
    "authorized_repos": ["org/repo1", "org/repo2"]
  }
}
```

**Scaling note:** For orgs with many repos, use `authorized_orgs` claim with wildcard matching (e.g., `"authorized_orgs": ["acme"]` matches any `acme/*` repo). Repo-level claims work fine for the current scale (<10 repos per user).

### Backward Compatibility

The bridge client currently uses `ZAPBOT_GATEWAY_SECRET`. During migration:
- Gateway accepts BOTH old shared-secret auth AND new JWT auth
- Legacy auth controlled by `LEGACY_AUTH_ENABLED` env var (defaults to `true`)
- Legacy auth creates a synthetic `GatewayUser` with `{ sub: "legacy", role: "owner", authorizedRepos: ["*"] }`
- Every legacy auth usage is logged with a deprecation warning
- New env var: `ZAPBOT_GATEWAY_TOKEN` for JWT-based auth on the bridge side
- **Sunset target:** Remove legacy auth support after all bridges migrate to JWT (target: 30 days after deploy)

### Design Decisions

**Webhook forwarding remains unauthenticated.** The `/api/webhooks/github` endpoint does NOT require auth at the gateway. GitHub webhook signature verification happens at the bridge level (`bin/webhook-bridge.ts:766`), not the gateway. The gateway is a stateless proxy that doesn't know per-repo webhook secrets. An attacker crafting payloads would fail at the bridge's HMAC verification.

**Bridges use regular user JWTs, not service role tokens.** Service role tokens bypass all Supabase RLS, which defeats per-user auth. Bridges should authenticate as a specific user (the bot owner) with `owner` role. If the JWT expires, the bridge logs a warning on the next heartbeat but doesn't crash (existing `heartbeat()` error handling in `client.ts:119-125`).

## Implementation Plan

### Phase 1: Gateway JWT Middleware

**Files:**
- NEW: `gateway/src/auth.ts` — JWT verification module
- MODIFY: `gateway/src/handler.ts` — Replace `verifyAuth` with JWT-aware auth
- MODIFY: `gateway/src/index.ts` — Add Supabase env var validation
- MODIFY: `gateway/.env.example` — Add Supabase env vars
- MODIFY: `gateway/package.json` — Add `jose` dependency

**`gateway/src/auth.ts`:**
```typescript
import { jwtVerify, type JWTPayload } from "jose";

export interface GatewayUser {
  sub: string;           // Supabase user ID (or "legacy" for shared-secret auth)
  email?: string;
  role: "owner" | "member";
  authorizedRepos: string[];  // ["org/repo1", "org/repo2"] or ["*"] for legacy
}

export interface AuthConfig {
  jwtSecret: string;              // SUPABASE_JWT_SECRET
  jwtIssuer?: string;             // Expected JWT issuer (Supabase project URL)
  legacySecret?: string;          // GATEWAY_SECRET (backward compat)
  legacyEnabled: boolean;         // LEGACY_AUTH_ENABLED
  maxAgeSeconds: number;          // Max JWT age (default: 3600 = 1 hour)
}

export type AuthResult =
  | { ok: true; user: GatewayUser }
  | { ok: false; error: AuthError };

export interface AuthError {
  type: string;           // e.g. "token_expired", "invalid_signature"
  message: string;        // Human-readable description
  fix: string;            // Actionable fix instruction
}

export async function verifyRequest(
  req: Request,
  config: AuthConfig,
): Promise<AuthResult>;

export function requireRole(
  user: GatewayUser,
  role: "owner" | "member",
): boolean;

export function requireRepoAccess(
  user: GatewayUser,
  repo: string,
): boolean;
```

**Auth flow:**
1. Extract `Authorization: Bearer <token>` header
2. Try JWT verification first (jose `jwtVerify` with SUPABASE_JWT_SECRET)
   - Validate signature (HS256)
   - Check expiration (`exp`)
   - Check max age (`iat` must be within `maxAgeSeconds`)
   - Validate issuer (`iss`) and audience (`aud: "authenticated"`)
   - Extract claims from `app_metadata`
3. If JWT verification fails AND `legacyEnabled` is true, try legacy shared-secret check
4. Legacy auth returns synthetic `GatewayUser { sub: "legacy", role: "owner", authorizedRepos: ["*"] }`
5. Log auth results: success (sub, email, role) or failure (type, truncated token hash)
6. NEVER log full JWT values

**Error responses (structured):**

| Error Type | HTTP | Message | Fix |
|---|---|---|---|
| `missing_token` | 401 | No Authorization header provided | Include `Authorization: Bearer <jwt>` header |
| `invalid_token_format` | 401 | Authorization header must be `Bearer <token>` | Check header format |
| `invalid_signature` | 401 | Token signature verification failed | Verify SUPABASE_JWT_SECRET matches your Supabase project |
| `token_expired` | 401 | Token expired at {timestamp} | Refresh your Supabase JWT |
| `token_too_old` | 401 | Token issued more than 1 hour ago | Obtain a fresh JWT |
| `invalid_issuer` | 401 | Token issuer does not match expected | Check SUPABASE_URL configuration |
| `missing_claims` | 401 | Token missing required claims: {list} | Set app_metadata.role and app_metadata.authorized_repos in Supabase |
| `insufficient_role` | 403 | Operation requires {required} role, you have {actual} | Contact bot owner for role upgrade |
| `repo_not_authorized` | 403 | Not authorized for repo {repo} | Add repo to your authorized_repos in Supabase |

**`handler.ts` changes:**
- Remove `verifyAuth()` and `parseAuthenticatedBody()`
- `GatewayConfig` gets new `authConfig: AuthConfig` field (replaces `gatewaySecret: string`)
- Register endpoint: verify auth, check `owner` role
- Deregister endpoint: verify auth, check `owner` role
- NEW: `GET /api/auth/me` endpoint: verify auth, return user info (for token validation)
- `/healthz` and `/api/webhooks/github`: no auth (unchanged)

### Phase 2: Bridge Client Updates

**Files:**
- MODIFY: `src/gateway/client.ts` — Support JWT token in addition to shared secret
- MODIFY: `bin/webhook-bridge.ts` — Read `ZAPBOT_GATEWAY_TOKEN` env var

**`GatewayClientConfig` changes:**
```typescript
export interface GatewayClientConfig {
  gatewayUrl: string;
  secret?: string;      // Legacy: ZAPBOT_GATEWAY_SECRET
  token?: string;       // New: ZAPBOT_GATEWAY_TOKEN (Supabase JWT)
}
```

Token selection: use `token` if set, fall back to `secret`. The `Authorization` header is `Bearer <value>` either way, so the wire format doesn't change.

**`bin/webhook-bridge.ts` changes:**
```typescript
// Before
const gatewaySecret = process.env.ZAPBOT_GATEWAY_SECRET;

// After
const gatewayToken = process.env.ZAPBOT_GATEWAY_TOKEN;
const gatewaySecret = process.env.ZAPBOT_GATEWAY_SECRET;
// ...
const config = {
  gatewayUrl,
  token: gatewayToken,      // JWT takes precedence
  secret: gatewaySecret,    // Legacy fallback
};
```

### Phase 3: Environment & Config

**Gateway env vars (new):**
- `SUPABASE_JWT_SECRET` — Required for JWT verification. Gateway exits on startup if missing AND `GATEWAY_SECRET` is also missing (at least one auth method required).
- `SUPABASE_URL` — Optional. Used to derive expected JWT issuer (`{SUPABASE_URL}/auth/v1`).
- `LEGACY_AUTH_ENABLED` — Optional, defaults to `true`. Set to `false` to disable shared-secret auth.
- `JWT_MAX_AGE_SECONDS` — Optional, defaults to `3600`. Maximum JWT age in seconds.

**Bridge env vars (new):**
- `ZAPBOT_GATEWAY_TOKEN` — Supabase JWT for bridge auth. Takes precedence over `ZAPBOT_GATEWAY_SECRET`.

**Backward compatibility:**
- `GATEWAY_SECRET` still works when `LEGACY_AUTH_ENABLED=true`
- `ZAPBOT_GATEWAY_SECRET` still works on the bridge side
- Gateway logs a deprecation warning on FIRST legacy auth usage per startup

**Startup validation in `index.ts`:**
```typescript
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";
const LEGACY_AUTH_ENABLED = process.env.LEGACY_AUTH_ENABLED !== "false";

if (!SUPABASE_JWT_SECRET && !GATEWAY_SECRET) {
  log("error", "Either SUPABASE_JWT_SECRET or GATEWAY_SECRET must be set.");
  process.exit(1);
}

if (!SUPABASE_JWT_SECRET) {
  log("warn", "SUPABASE_JWT_SECRET not set. Only legacy auth available.");
}

if (GATEWAY_SECRET && LEGACY_AUTH_ENABLED) {
  log("warn", "Legacy auth enabled. Set LEGACY_AUTH_ENABLED=false after migrating bridges to JWT.");
}
```

### Phase 4: Tests

**Files:**
- NEW: `gateway/test/auth.test.ts` — Unit tests for JWT verification
- MODIFY: `gateway/test/gateway-endpoints.test.ts` — Add JWT auth tests
- MODIFY: `test/gateway-client.test.ts` — Test token-based auth

**Test JWT generation helper:**
```typescript
import { SignJWT } from "jose";

const TEST_JWT_SECRET = "test-jwt-secret-at-least-32-chars-long!!";
const encoder = new TextEncoder();

async function createTestJWT(
  claims: Record<string, unknown>,
  options?: { expiresIn?: string; iat?: number }
) {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("https://test.supabase.co/auth/v1")
    .setAudience("authenticated")
    .setExpirationTime(options?.expiresIn || "1h");

  if (options?.iat) {
    builder.setIssuedAt(options.iat);
  } else {
    builder.setIssuedAt();
  }

  return builder.sign(encoder.encode(TEST_JWT_SECRET));
}
```

**Test cases: `gateway/test/auth.test.ts` (19 tests)**
See test plan artifact for full list. Key coverage:
- JWT: valid owner, valid member, expired, invalid sig, wrong issuer, wrong audience, too old, missing claims
- Legacy: success when enabled, rejected when disabled
- Role checks: owner passes, member blocked for owner-only ops
- Repo access: authorized passes, unauthorized blocked, owner bypasses

**Test cases: `gateway/test/gateway-endpoints.test.ts` (10 new tests)**
- Register/deregister with JWT owner (200), JWT member (403), legacy (200), no auth (401)
- `/api/auth/me` with valid JWT, expired JWT
- Existing unauthenticated endpoints remain accessible

**Test cases: `test/gateway-client.test.ts` (4 new tests)**
- Register with JWT token, register with legacy secret, token takes precedence, heartbeat with expired JWT

### Phase 5: team-init Updates

**Files:**
- MODIFY: `bin/zapbot-team-init` — Prompt for gateway auth method during setup

**Changes:**
- Add question: "Gateway auth: (1) Supabase JWT token, (2) Shared secret (legacy)"
- If JWT: write `ZAPBOT_GATEWAY_TOKEN=<token>` to .env
- If shared secret: write `ZAPBOT_GATEWAY_SECRET=<secret>` to .env (existing behavior)

## Quick Start

### Gateway Setup
```bash
# 1. Set env vars on Railway
SUPABASE_JWT_SECRET=your-jwt-secret-from-supabase-dashboard
GATEWAY_SECRET=your-existing-shared-secret  # Keep for backward compat
LEGACY_AUTH_ENABLED=true                     # Enable during migration

# 2. Deploy
railway up
```

### Bridge Setup
```bash
# In your bridge's .env:
ZAPBOT_GATEWAY_URL=https://zapbot-gateway.up.railway.app
ZAPBOT_GATEWAY_TOKEN=eyJhbGciOiJIUzI1NiIs...  # Your Supabase JWT

# Or legacy (deprecated):
# ZAPBOT_GATEWAY_SECRET=your-shared-secret
```

### Verify Token
```bash
# Test your JWT with the /api/auth/me endpoint
curl -H "Authorization: Bearer $ZAPBOT_GATEWAY_TOKEN" \
  https://zapbot-gateway.up.railway.app/api/auth/me

# Expected response:
# { "sub": "user-uuid", "email": "you@example.com", "role": "owner" }
```

### Register a Bridge
```bash
curl -X POST \
  -H "Authorization: Bearer $ZAPBOT_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"org/repo","bridgeUrl":"http://your-bridge:3000"}' \
  https://zapbot-gateway.up.railway.app/api/bridges/register

# Expected: { "ok": true, "repo": "org/repo", "registeredAt": 1234567890 }
```

## Out of Scope

- Supabase project creation/configuration (external setup, Supabase dashboard)
- `authorized_users` table schema and RLS policies (Supabase dashboard)
- GitHub OAuth provider configuration (Supabase dashboard)
- GitHub App installation tokens as auth mechanism (separate sub-issue per #44)
- API key auth for CI/CD (future PR, auth module is extensible)
- Rate limiting per user (future PR)
- Multi-tenant data model (parent issue #44 concern)
- Configurable JWT claim paths (defer until needed, `GatewayUser` interface is the extension point)

## Dependencies

- `jose` npm package (JWT verification, ~15KB, zero dependencies, well-maintained, standard)
- Supabase project with JWT secret configured (external dependency)

## Risks

1. **JWT expiration during heartbeat** — Bridge JWT expires between heartbeats. Mitigation: bridges use regular user JWTs (not service role tokens). The existing `heartbeat()` catches errors and warns. Bridge operators should set JWT expiry > 1 hour.
2. **Backward compatibility breakage** — Existing deployments use shared-secret auth. Mitigation: dual-mode auth with `LEGACY_AUTH_ENABLED` flag. Legacy creates synthetic `GatewayUser` so all code paths are uniform.
3. **Custom claims dependency** — Relying on `app_metadata` for repo authorization couples to Supabase's JWT structure. Mitigation: abstract behind `GatewayUser` interface, easy to swap claim source.
4. **Stale authorization in JWT claims** — If repo access is revoked in Supabase, the JWT still carries old claims until it expires. Mitigation: `maxAgeSeconds` check (default 1 hour) limits the window. For immediate revocation, deploy a blocklist (future PR).

## Architecture Diagram

```
                    ┌─────────────────────┐
                    │   GitHub Webhooks    │
                    └──────────┬──────────┘
                               │ POST /api/webhooks/github
                               │ (no auth, signature verified at bridge)
                               ▼
┌──────────┐    ┌─────────────────────────────────┐
│ Supabase │    │     Railway Gateway              │
│  Auth    │    │  ┌─────────┐  ┌──────────────┐  │
│ (issues  │    │  │ auth.ts │  │  handler.ts   │  │
│  JWTs)   │    │  │ verify  │──│  route        │  │
└──────────┘    │  │ JWT     │  │  dispatch     │  │
                │  │ + legacy│  └──────┬───────┘  │
                │  └─────────┘         │           │
                │  ┌──────────────────┐│           │
                │  │  registry.ts     ││           │
                │  │  bridge map      │◄           │
                │  └────────┬─────────┘            │
                └───────────┼──────────────────────┘
                            │ forward webhook
                            ▼
                ┌───────────────────────┐
                │   Local Bridge        │
                │   (webhook-bridge.ts) │
                │   Auth: Bearer JWT    │
                │   via client.ts       │
                └───────────────────────┘
```

**Auth boundary:**
- `/healthz` — No auth (public health check)
- `/api/webhooks/github` — No auth (GitHub sig verification at bridge)
- `/api/bridges/register` — JWT required, `owner` role required
- `/api/bridges/register` (DELETE) — JWT required, `owner` role required
- `/api/auth/me` — JWT required (any role)

## Observability

**Structured log lines:**
- `auth.verify: success` — `{ sub, email, role, repo_count, method: "jwt" | "legacy" }`
- `auth.verify: failed` — `{ type, method: "jwt" | "legacy", token_hash: first_8_chars }`
- `auth.legacy: deprecation` — Logged once per startup when legacy auth is used
- `auth.startup: config` — `{ jwt_enabled, legacy_enabled, max_age_s }`

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|---------------|-----------|-----------|----------|
| 1 | CEO | Approach A (jose) over B (Supabase SDK) and C (proxy auth) | Mechanical | P5, P3 | Simplest, fastest, zero external deps at request time | B (SDK weight), C (no repo authz) |
| 2 | CEO | SELECTIVE EXPANSION mode | Mechanical | P6 | Feature enhancement on existing system | — |
| 3 | CEO | Include audit logging of auth events | Mechanical | P1, P2 | Auth events MUST be logged, ~15 LOC, in blast radius | — |
| 4 | CEO | Include /api/auth/me endpoint | Mechanical | P1 | Useful for DX, ~10 LOC, lets operators verify tokens | — |
| 5 | CEO | Defer API key auth for CI/CD | Mechanical | P3 | Not needed for v1, auth module is extensible | — |
| 6 | CEO | Defer rate limiting | Mechanical | P3 | Out of scope per issue | — |
| 7 | CEO | Defer token refresh mechanism | Mechanical | P3 | Bridges use long-lived user tokens | — |
| 8 | CEO | Accept Supabase as specified (not GitHub App tokens) | Taste | P6 | Parent issue #44 explicitly separates these. GatewayUser interface makes swap easy | GitHub App tokens |
| 9 | Eng | Add max_age JWT check (1 hour) | Mechanical | P1 | Limits stale authorization window | — |
| 10 | Eng | Add LEGACY_AUTH_ENABLED env var | Mechanical | P5, P1 | Explicit kill switch for legacy backdoor | — |
| 11 | Eng | Synthetic GatewayUser for legacy auth | Mechanical | P5, P4 | Eliminates dual code paths, single type everywhere | Separate AuthResult variant |
| 12 | Eng | Webhook path stays unauthenticated | Mechanical | P5 | Bridge verifies HMAC, gateway doesn't know secrets | Gateway-level HMAC check |
| 13 | Eng | Add issuer/audience validation | Mechanical | P1 | jose accepts any valid JWT by default without these | — |
| 14 | Eng | Add org-level claims doc | Taste | P3 | Document scaling path without implementing | Implement org claims now |
| 15 | DX | Add Quick Start section | Mechanical | P1 | Zero guidance = critical DX gap | — |
| 16 | DX | Add structured error responses | Mechanical | P1, P5 | Auth errors must be actionable | — |
| 17 | DX | Keep existing env var names | Mechanical | P3 | Renaming breaks existing deployments | New naming scheme |
| 18 | DX | Defer configurable claim paths | Mechanical | P5, P3 | Over-engineering, GatewayUser is the extension point | JWT_ROLE_CLAIM_PATH env var |

## Cross-Phase Themes

**Theme: Stale authorization claims** — Flagged in CEO (custom claims dependency) and Eng (JWT TOCTOU). High-confidence signal. Mitigated by max_age check and documented as a known limitation with blocklist as future work.

**Theme: Legacy auth as security risk** — Flagged in CEO (backward compatibility) and Eng (permanent backdoor). Mitigated by LEGACY_AUTH_ENABLED kill switch and sunset target.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | clean | 6 subagent findings, all resolved |
| Codex Review | `codex exec` | Independent 2nd opinion | 0 | unavailable | Codex timed out in all phases |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | clean | 6 subagent findings, all resolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | No UI scope detected |
| DX Review | `/plan-devex-review` | Developer experience | 1 | clean | 5 subagent findings, 4 resolved, 1 deferred |

**VERDICT:** REVIEWED — 3 phases complete (CEO, Eng, DX). 17 findings total, 16 resolved, 1 deferred (configurable claim paths). Plan is ready for human review.
