import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Effect } from "effect";
import { createGitHubClient, getInstallationToken } from "../src/github/client.ts";
import { createLogger } from "../src/logger.ts";

const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

describe("GitHub client factory", () => {
  it("creates a token-authenticated client", async () => {
    const client = await Effect.runPromise(createGitHubClient(
      { _tag: "GitHubPat", token: "test-token-123" },
      createLogger("github-test", "info"),
    ));
    expect(typeof client.addLabel).toBe("function");
  });

  it("creates an app-authenticated client", async () => {
    const client = await Effect.runPromise(createGitHubClient(
      {
        _tag: "GitHubApp",
        appId: "12345",
        installationId: "67890",
        privateKeyPem: TEST_PRIVATE_KEY,
      },
      createLogger("github-test", "info"),
    ));
    expect(typeof client.addLabel).toBe("function");
  });

  it("rejects empty token auth", async () => {
    const result = await Effect.runPromise(Effect.either(createGitHubClient(
      { _tag: "GitHubPat", token: "" },
      createLogger("github-test", "info"),
    )));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "GitHubAuthInvalid",
      });
    }
  });

  it("returns null installation token in PAT mode", async () => {
    const token = await Effect.runPromise(getInstallationToken({
      _tag: "GitHubPat",
      token: "pat-token",
    }));
    expect(token).toBeNull();
  });
});
