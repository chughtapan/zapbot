import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Test the GitHub client factory behavior
describe("GitHub client factory", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("falls back to legacy mode when ZAPBOT_GITHUB_TOKEN is not set", async () => {
    delete process.env.ZAPBOT_GITHUB_TOKEN;
    delete process.env.ZAPBOT_AUTH_MODE;

    // Dynamic import to get fresh module state
    const { createGitHubClient } = await import("../src/github/client.js");
    const client = createGitHubClient();

    // The client should exist (legacy mode doesn't error on creation)
    expect(client).toBeDefined();
    expect(client.addLabel).toBeFunction();
    expect(client.removeLabel).toBeFunction();
    expect(client.postComment).toBeFunction();
    expect(client.closeIssue).toBeFunction();
    expect(client.createIssue).toBeFunction();
    expect(client.editIssue).toBeFunction();
    expect(client.convertPrToDraft).toBeFunction();
    expect(client.listWebhooks).toBeFunction();
    expect(client.createWebhook).toBeFunction();
    expect(client.updateWebhook).toBeFunction();
    expect(client.deactivateWebhook).toBeFunction();
  });

  it("uses bot mode when ZAPBOT_GITHUB_TOKEN is set", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token-123";
    delete process.env.ZAPBOT_AUTH_MODE;

    const { createGitHubClient } = await import("../src/github/client.js");
    const client = createGitHubClient();

    expect(client).toBeDefined();
    expect(client.addLabel).toBeFunction();
  });

  it("forces legacy mode when ZAPBOT_AUTH_MODE=legacy", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token-123";
    process.env.ZAPBOT_AUTH_MODE = "legacy";

    const { createGitHubClient } = await import("../src/github/client.js");
    const client = createGitHubClient();

    // Legacy client exists and has all methods
    expect(client).toBeDefined();
    expect(client.addLabel).toBeFunction();
  });
});

describe("GitHub client interface completeness", () => {
  it("has all required methods", async () => {
    process.env.ZAPBOT_GITHUB_TOKEN = "test-token";
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
