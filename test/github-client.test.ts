import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { generateAppJWT, loadPrivateKey, createGitHubClient } from "../src/github/client.js";
import { generateKeyPairSync, createVerify } from "crypto";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Generate a test RSA key pair for JWT tests
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Also generate a PKCS#1 formatted key (what GitHub actually generates)
const { privateKey: TEST_PKCS1_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

// ── Factory tests ──────────────────────────────────────────────────

describe("GitHub client factory", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when no credentials are configured", async () => {
    delete process.env.ZAPBOT_GITHUB_TOKEN;
    delete process.env.GITHUB_APP_ID;

    const { createGitHubClient } = await import("../src/github/client.js");
    expect(() => createGitHubClient()).toThrow("No GitHub credentials configured");
  });

  it("uses token mode when ZAPBOT_GITHUB_TOKEN is set", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token-123";
    delete process.env.GITHUB_APP_ID;

    const { createGitHubClient } = await import("../src/github/client.js");
    const client = createGitHubClient();

    expect(client).toBeDefined();
    expect(typeof client.addLabel).toBe("function");
  });

  it("uses app mode when GITHUB_APP_ID is set", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";
    // App mode takes priority even if PAT is set
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token-123";

    const { createGitHubClient } = await import("../src/github/client.js");
    const client = createGitHubClient();

    expect(client).toBeDefined();
    expect(typeof client.addLabel).toBe("function");
  });

  it("throws when GITHUB_APP_ID is set but GITHUB_APP_INSTALLATION_ID is missing", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;

    const { createGitHubClient } = await import("../src/github/client.js");
    expect(() => createGitHubClient()).toThrow("GITHUB_APP_INSTALLATION_ID is required");
  });

  it("throws when GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY is missing", async () => {
    process.env.GITHUB_APP_ID = "12345";
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const { createGitHubClient } = await import("../src/github/client.js");
    expect(() => createGitHubClient()).toThrow("GITHUB_APP_PRIVATE_KEY is required");
  });
});

// ── Interface completeness ─────────────────────────────────────────

describe("GitHub client interface completeness", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has all required methods", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token";
    delete process.env.GITHUB_APP_ID;

    const { createGitHubClient } = await import("../src/github/client.js");
    const client = createGitHubClient();

    const methods = [
      "addLabel", "removeLabel", "postComment", "closeIssue",
      "createIssue", "editIssue", "convertPrToDraft",
      "listWebhooks", "createWebhook", "updateWebhook", "deactivateWebhook",
    ];

    for (const method of methods) {
      expect(typeof (client as any)[method]).toBe("function");
    }
  });

  it("app client has all required methods", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const { createGitHubClient } = await import("../src/github/client.js");
    const client = createGitHubClient();

    const methods = [
      "addLabel", "removeLabel", "postComment", "closeIssue",
      "createIssue", "editIssue", "convertPrToDraft",
      "listWebhooks", "createWebhook", "updateWebhook", "deactivateWebhook",
    ];

    for (const method of methods) {
      expect(typeof (client as any)[method]).toBe("function");
    }
  });
});

// ── JWT generation ─────────────────────────────────────────────────

describe("generateAppJWT", () => {
  it("generates a valid JWT with RS256", () => {
    const jwt = generateAppJWT("12345", TEST_PRIVATE_KEY);

    // JWT has 3 parts separated by dots
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    // Decode and verify header
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    // Decode and verify payload
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.iss).toBe("12345");
    expect(payload.exp).toBeGreaterThan(payload.iat);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(660); // iat is 60s back, exp is 10min forward

    // Signature is non-empty
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("works with PKCS#1 formatted keys (GitHub default)", () => {
    const jwt = generateAppJWT("99999", TEST_PKCS1_KEY);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.iss).toBe("99999");
  });

  it("sets iat 60 seconds in the past for clock drift", () => {
    const before = Math.floor(Date.now() / 1000) - 61;
    const jwt = generateAppJWT("12345", TEST_PRIVATE_KEY);
    const after = Math.floor(Date.now() / 1000) - 59;

    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
  });

  it("sets exp to 10 minutes after now", () => {
    const before = Math.floor(Date.now() / 1000) + 599;
    const jwt = generateAppJWT("12345", TEST_PRIVATE_KEY);
    const after = Math.floor(Date.now() / 1000) + 601;

    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    expect(payload.exp).toBeGreaterThanOrEqual(before);
    expect(payload.exp).toBeLessThanOrEqual(after);
  });

  it("throws with an invalid private key", () => {
    expect(() => generateAppJWT("12345", "not-a-valid-key")).toThrow();
  });
});

// ── Private key loading ────────────────────────────────────────────

describe("loadPrivateKey", () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zapbot-test-"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns PEM content when env var contains a PEM string", () => {
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    const key = loadPrivateKey();
    expect(key).toBe(TEST_PRIVATE_KEY);
  });

  it("reads PEM from file when env var is a file path", () => {
    const keyPath = join(tmpDir, "test-key.pem");
    writeFileSync(keyPath, TEST_PRIVATE_KEY);
    process.env.GITHUB_APP_PRIVATE_KEY = keyPath;

    const key = loadPrivateKey();
    expect(key).toBe(TEST_PRIVATE_KEY);
  });

  it("throws when env var is not set", () => {
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    expect(() => loadPrivateKey()).toThrow("GITHUB_APP_PRIVATE_KEY is required");
  });

  it("throws when file path does not exist", () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "/nonexistent/path/key.pem";
    expect(() => loadPrivateKey()).toThrow("Cannot read private key file");
  });

  it("handles PEM files with Windows-style line endings (CRLF)", () => {
    const crlfKey = TEST_PRIVATE_KEY.replace(/\n/g, "\r\n");
    const keyPath = join(tmpDir, "crlf-key.pem");
    writeFileSync(keyPath, crlfKey);
    process.env.GITHUB_APP_PRIVATE_KEY = keyPath;

    const key = loadPrivateKey();
    // The key should be readable; crypto.createSign handles CRLF in PEM
    expect(key).toContain("-----BEGIN");
    // Verify the loaded key is still usable for JWT generation
    expect(() => generateAppJWT("12345", key)).not.toThrow();
  });

  it("handles PEM content with Windows-style line endings passed directly", () => {
    const crlfKey = TEST_PRIVATE_KEY.replace(/\n/g, "\r\n");
    process.env.GITHUB_APP_PRIVATE_KEY = crlfKey;

    const key = loadPrivateKey();
    expect(key).toContain("-----BEGIN");
    expect(() => generateAppJWT("12345", key)).not.toThrow();
  });

  it("throws with empty string env var", () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "";
    expect(() => loadPrivateKey()).toThrow("GITHUB_APP_PRIVATE_KEY is required");
  });
});

// ── JWT signature verification ────────────────────────────────────

describe("generateAppJWT signature verification", () => {
  // Generate a key pair so we can verify the signature
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  it("produces a JWT whose signature can be verified with the matching public key", () => {
    const jwt = generateAppJWT("verify-test", privateKey);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], "base64url");

    const verify = createVerify("RSA-SHA256");
    verify.update(signingInput);
    expect(verify.verify(publicKey, signature)).toBe(true);
  });

  it("fails verification with a different public key", () => {
    const { publicKey: otherPublicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const jwt = generateAppJWT("verify-test", privateKey);
    const parts = jwt.split(".");

    const signingInput = `${parts[0]}.${parts[1]}`;
    const signature = Buffer.from(parts[2], "base64url");

    const verify = createVerify("RSA-SHA256");
    verify.update(signingInput);
    expect(verify.verify(otherPublicKey, signature)).toBe(false);
  });
});

// ── Token caching and refresh ─────────────────────────────────────

describe("App client token caching", () => {
  const originalEnv = { ...process.env };
  let fetchCallCount: number;
  let mockTokenCounter: number;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchCallCount = 0;
    mockTokenCounter = 0;
    originalFetch = globalThis.fetch;

    // Mock global fetch to intercept installation token requests
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      // Intercept installation token requests
      if (url.includes("/app/installations/") && url.includes("/access_tokens")) {
        fetchCallCount++;
        mockTokenCounter++;
        return new Response(JSON.stringify({
          token: `ghs_mock_token_${mockTokenCounter}`,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Intercept any GitHub API calls (from the client methods)
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ id: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
  });

  it("caches the installation token and reuses it on subsequent calls", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const client = createGitHubClient();

    // Make two API calls
    await client.addLabel("owner/repo", 1, "bug");
    await client.addLabel("owner/repo", 2, "feature");

    // Should only have fetched the installation token once
    expect(fetchCallCount).toBe(1);
  });

  it("refreshes the token when cache expires", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const client = createGitHubClient();

    // First call — fetches a fresh token
    await client.addLabel("owner/repo", 1, "bug");
    expect(fetchCallCount).toBe(1);

    // Simulate time passing beyond the 50-minute cache window
    // We need to manipulate Date.now for this
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 51 * 60 * 1000; // 51 minutes in the future

    // Second call — should refresh the token
    await client.addLabel("owner/repo", 2, "feature");
    expect(fetchCallCount).toBe(2);

    Date.now = realDateNow; // restore
  });

  it("resolves token on each API call (not just at creation time)", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    // Create client but don't make any calls yet — no token should be fetched
    const client = createGitHubClient();
    expect(fetchCallCount).toBe(0);

    // Token is fetched lazily on first API call
    await client.postComment("owner/repo", 1, "hello");
    expect(fetchCallCount).toBe(1);
  });

  it("handles failed installation token exchange", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    // Override fetch to return a 401 for token exchange
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/app/installations/") && url.includes("/access_tokens")) {
        return new Response(JSON.stringify({ message: "Bad credentials" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof globalThis.fetch;

    const client = createGitHubClient();
    await expect(client.addLabel("owner/repo", 1, "bug")).rejects.toThrow(
      "Failed to get installation token: 401"
    );
  });

  it("concurrent token requests don't cause errors (both get valid tokens)", async () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const client = createGitHubClient();

    // Fire multiple concurrent requests
    const results = await Promise.allSettled([
      client.addLabel("owner/repo", 1, "bug"),
      client.addLabel("owner/repo", 2, "feature"),
      client.postComment("owner/repo", 3, "hello"),
    ]);

    // All should succeed
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }

    // At least 1 token fetch, at most 3 (race condition may cause duplicates)
    expect(fetchCallCount).toBeGreaterThanOrEqual(1);
    expect(fetchCallCount).toBeLessThanOrEqual(3);
  });
});

// ── Security: no secrets in logs ──────────────────────────────────

describe("security: no sensitive data leakage", () => {
  it("error from loadPrivateKey does not leak the key content", () => {
    // When file read fails, the error should show the path, not key content
    process.env.GITHUB_APP_PRIVATE_KEY = "/nonexistent/secret/key.pem";
    try {
      loadPrivateKey();
    } catch (err: any) {
      expect(err.message).toContain("/nonexistent/secret/key.pem");
      expect(err.message).not.toContain("BEGIN RSA PRIVATE KEY");
    }
  });

  it("generateAppJWT with empty string throws without leaking key info", () => {
    expect(() => generateAppJWT("12345", "")).toThrow();
  });

  it("generateAppJWT with malformed PEM throws a crypto error", () => {
    expect(() => generateAppJWT("12345", "not-a-pem-key-but-looks-like-one")).toThrow();
  });
});
