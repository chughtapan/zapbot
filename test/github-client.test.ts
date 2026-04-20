import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { loadPrivateKey, createGitHubClient } from "../v2/github/client.js";
import { generateKeyPairSync } from "crypto";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Generate a test RSA key pair
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// ── Factory tests ──────────────────────────────────────────────────

describe("GitHub client factory", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws when no credentials are configured", () => {
    delete process.env.ZAPBOT_GITHUB_TOKEN;
    delete process.env.GITHUB_APP_ID;

    expect(() => createGitHubClient()).toThrow("No GitHub credentials configured");
  });

  it("uses token mode when ZAPBOT_GITHUB_TOKEN is set", () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token-123";
    delete process.env.GITHUB_APP_ID;

    const client = createGitHubClient();
    expect(client).toBeDefined();
    expect(typeof client.addLabel).toBe("function");
  });

  it("uses app mode when GITHUB_APP_ID is set", () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const client = createGitHubClient();
    expect(client).toBeDefined();
    expect(typeof client.addLabel).toBe("function");
  });

  it("throws when GITHUB_APP_ID is set but GITHUB_APP_INSTALLATION_ID is missing", () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    delete process.env.GITHUB_APP_INSTALLATION_ID;

    expect(() => createGitHubClient()).toThrow("GITHUB_APP_INSTALLATION_ID is required");
  });

  it("throws when GITHUB_APP_ID is set but GITHUB_APP_PRIVATE_KEY is missing", () => {
    process.env.GITHUB_APP_ID = "12345";
    delete process.env.GITHUB_APP_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    expect(() => createGitHubClient()).toThrow("GITHUB_APP_PRIVATE_KEY is required");
  });
});

// ── Interface completeness ─────────────────────────────────────────

describe("GitHub client interface completeness", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has all required methods", () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token";
    delete process.env.GITHUB_APP_ID;

    const client = createGitHubClient();

    const methods = [
      "addLabel", "removeLabel", "postComment", "updateComment", "closeIssue",
      "createIssue", "editIssue", "convertPrToDraft",
      "addReaction", "addIssueReaction", "assignIssue", "getUserPermission",
      "getIssue", "getIssueState", "getIssueBody",
      "listWebhooks", "createWebhook", "updateWebhook", "deactivateWebhook",
    ];

    for (const method of methods) {
      expect(typeof (client as any)[method]).toBe("function");
    }
  });

  it("app client has all required methods", () => {
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_APP_PRIVATE_KEY = TEST_PRIVATE_KEY;
    process.env.GITHUB_APP_INSTALLATION_ID = "67890";

    const client = createGitHubClient();

    const methods = [
      "addLabel", "removeLabel", "postComment", "updateComment", "closeIssue",
      "createIssue", "editIssue", "convertPrToDraft",
      "addReaction", "addIssueReaction", "assignIssue", "getUserPermission",
      "getIssue", "getIssueState", "getIssueBody",
      "listWebhooks", "createWebhook", "updateWebhook", "deactivateWebhook",
    ];

    for (const method of methods) {
      expect(typeof (client as any)[method]).toBe("function");
    }
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

  it("throws with empty string env var", () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "";
    expect(() => loadPrivateKey()).toThrow("GITHUB_APP_PRIVATE_KEY is required");
  });
});

// ── Security: no secrets in logs ──────────────────────────────────

describe("security: no sensitive data leakage", () => {
  it("error from loadPrivateKey does not leak the key content", () => {
    process.env.GITHUB_APP_PRIVATE_KEY = "/nonexistent/secret/key.pem";
    try {
      loadPrivateKey();
    } catch (err: any) {
      expect(err.message).toContain("/nonexistent/secret/key.pem");
      expect(err.message).not.toContain("BEGIN RSA PRIVATE KEY");
    }
  });
});
