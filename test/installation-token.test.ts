import { describe, it, expect } from "vitest";
import {
  handleInstallationTokenRequest,
  verifyBearer,
  type InstallationTokenDeps,
} from "../v2/http/routes/installation-token.js";

const API_KEY = "test-zapbot-api-key-abcdef0123456789";
const FAKE_EXPIRES_AT = "2026-04-18T01:00:00Z";

function deps(overrides: Partial<InstallationTokenDeps> = {}): InstallationTokenDeps {
  return {
    mintToken: async () => ({ token: "ghs_mockinstallationtoken", expiresAt: FAKE_EXPIRES_AT }),
    apiKey: API_KEY,
    ...overrides,
  };
}

function request(init: { auth?: string } = {}): Request {
  const headers = new Headers();
  if (init.auth !== undefined) headers.set("authorization", init.auth);
  return new Request("http://localhost:3000/api/tokens/installation", {
    method: "GET",
    headers,
  });
}

describe("verifyBearer", () => {
  it("returns unauthorized on missing header", () => {
    expect(verifyBearer(null, API_KEY)).toMatchObject({ error: "unauthorized" });
  });

  it("returns unauthorized on empty header", () => {
    expect(verifyBearer("", API_KEY)).toMatchObject({ error: "unauthorized" });
  });

  it("rejects non-Bearer schemes", () => {
    expect(verifyBearer(`Basic ${API_KEY}`, API_KEY)).toMatchObject({ error: "unauthorized" });
  });

  it("rejects length-mismatched credentials without timingSafeEqual throw", () => {
    expect(verifyBearer("Bearer short", API_KEY)).toMatchObject({ error: "unauthorized" });
  });

  it("rejects a wrong token of matching length", () => {
    const wrong = "x".repeat(API_KEY.length);
    expect(verifyBearer(`Bearer ${wrong}`, API_KEY)).toMatchObject({ error: "unauthorized" });
  });

  it("accepts a correct Bearer token", () => {
    expect(verifyBearer(`Bearer ${API_KEY}`, API_KEY)).toBeNull();
  });
});

describe("handleInstallationTokenRequest", () => {
  it("vends a token on authenticated request", async () => {
    const result = await handleInstallationTokenRequest(
      request({ auth: `Bearer ${API_KEY}` }),
      deps(),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("unreachable");
    expect(result.body.token).toBe("ghs_mockinstallationtoken");
    // expires_at is the real GitHub App installation expiry — not a
    // wall-clock guess computed from `now()`.
    expect(result.body.expires_at).toBe(FAKE_EXPIRES_AT);
  });

  it("propagates the real expiresAt from mintToken (no wall-clock guess)", async () => {
    const realExpiresAt = "2026-04-18T03:59:59Z";
    const result = await handleInstallationTokenRequest(
      request({ auth: `Bearer ${API_KEY}` }),
      deps({
        mintToken: async () => ({ token: "ghs_another", expiresAt: realExpiresAt }),
      }),
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("unreachable");
    expect(result.body.expires_at).toBe(realExpiresAt);
  });

  it("returns 401 when Authorization header is missing", async () => {
    const result = await handleInstallationTokenRequest(request(), deps());
    expect(result.status).toBe(401);
    if (result.status !== 401) throw new Error("unreachable");
    expect(result.body.error).toBe("unauthorized");
  });

  it("returns 401 when Bearer credentials are wrong", async () => {
    const result = await handleInstallationTokenRequest(
      request({ auth: `Bearer ${"x".repeat(API_KEY.length)}` }),
      deps(),
    );
    expect(result.status).toBe(401);
  });

  it("returns 409 app_not_configured when mintToken returns null", async () => {
    const result = await handleInstallationTokenRequest(
      request({ auth: `Bearer ${API_KEY}` }),
      deps({ mintToken: async () => null }),
    );
    expect(result.status).toBe(409);
    if (result.status !== 409) throw new Error("unreachable");
    expect(result.body.error).toBe("app_not_configured");
  });

  it("returns 500 internal_error on mintToken exception without leaking the cause", async () => {
    const result = await handleInstallationTokenRequest(
      request({ auth: `Bearer ${API_KEY}` }),
      deps({
        mintToken: async () => {
          throw new Error("-----BEGIN PRIVATE KEY----- secret pem fragment");
        },
      }),
    );
    expect(result.status).toBe(500);
    if (result.status !== 500) throw new Error("unreachable");
    expect(result.body.error).toBe("internal_error");
    expect(result.body.message).not.toContain("PRIVATE KEY");
    expect(result.body.message).not.toContain("pem");
  });

  it("does not call mintToken when authorization fails", async () => {
    let called = false;
    const result = await handleInstallationTokenRequest(
      request({ auth: "Bearer wrong" }),
      deps({
        mintToken: async () => {
          called = true;
          return { token: "should-not-be-reached", expiresAt: "2099-01-01T00:00:00Z" };
        },
      }),
    );
    expect(result.status).toBe(401);
    expect(called).toBe(false);
  });
});
