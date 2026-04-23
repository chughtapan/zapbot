import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { appendProjectRoute, initializeProjectConfig } from "../src/config/bootstrap.ts";
import { asRepoCheckoutPath } from "../src/config/home.ts";
import { createConfigService } from "../src/config/service.ts";

describe("canonical config service", () => {
  let fakeHome: string;
  let checkoutPath: string;
  let secondCheckoutPath: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "zapbot-home-"));
    checkoutPath = mkdtempSync(join(tmpdir(), "zapbot-checkout-"));
    secondCheckoutPath = mkdtempSync(join(tmpdir(), "zapbot-checkout-"));
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(checkoutPath, { recursive: true, force: true });
    rmSync(secondCheckoutPath, { recursive: true, force: true });
    delete process.env.HOME;
    delete process.env.ZAPBOT_CHECKOUT_PATH;
    delete process.env.ZAPBOT_PORT;
    delete process.env.ZAPBOT_AO_PORT;
    delete process.env.ZAPBOT_API_KEY;
    delete process.env.ZAPBOT_REPO;
    delete process.env.ZAPBOT_WEBHOOK_SECRET;
    delete process.env.ZAPBOT_GITHUB_TOKEN;
  });

  it("loads runtime from ~/.zapbot only", async () => {
    await Effect.runPromise(initializeProjectConfig({
      checkoutPath,
      repo: "chughtapan/zapbot",
    }));
    const runtime = await Effect.runPromise(createConfigService().loadProjectRuntime({
      checkoutPath: asRepoCheckoutPath(checkoutPath),
    }));

    expect(runtime.projectHome.checkoutPath).toBe(checkoutPath);
    expect(runtime.routes.has("chughtapan/zapbot")).toBe(true);
    expect(runtime.apiKey.length).toBeGreaterThan(10);
    expect(runtime.ingress.mode).toBe("local-only");
  });

  it("resolves the canonical project from any configured repo checkout", async () => {
    const receipt = await Effect.runPromise(initializeProjectConfig({
      checkoutPath,
      repo: "owner/primary-repo",
    }));
    await Effect.runPromise(appendProjectRoute({
      checkoutPath: secondCheckoutPath,
      projectKey: receipt.projectKey,
      repo: "owner/secondary-repo",
    }));

    const runtime = await Effect.runPromise(createConfigService().loadProjectRuntime({
      checkoutPath: asRepoCheckoutPath(secondCheckoutPath),
    }));

    expect(runtime.projectHome.checkoutPath).toBe(secondCheckoutPath);
    expect(runtime.routes.get("owner/primary-repo")?.checkoutPath).toBe(checkoutPath);
    expect(runtime.routes.get("owner/secondary-repo")?.checkoutPath).toBe(secondCheckoutPath);
  });

  it("fails closed when repo-local legacy config artifacts are present", async () => {
    await Effect.runPromise(initializeProjectConfig({
      checkoutPath,
      repo: "chughtapan/zapbot",
    }));
    writeFileSync(join(checkoutPath, ".env"), "ZAPBOT_API_KEY=legacy\n", "utf8");

    const result = await Effect.runPromise(Effect.either(createConfigService().loadProjectRuntime({
      checkoutPath: asRepoCheckoutPath(checkoutPath),
    })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "LegacyRepoLocalConfigUnsupported",
        path: join(checkoutPath, ".env"),
      });
    }
  });

  it("fails when the canonical home is missing", async () => {
    rmSync(fakeHome, { recursive: true, force: true });
    const result = await Effect.runPromise(Effect.either(createConfigService().loadProjectRuntime({
      checkoutPath: asRepoCheckoutPath(checkoutPath),
    })));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "ZapbotHomeMissing",
      });
    }
  });

  it("loads hosted bridge runtime from env via the typed boundary", async () => {
    process.env.ZAPBOT_CHECKOUT_PATH = checkoutPath;
    process.env.ZAPBOT_PORT = "3000";
    process.env.ZAPBOT_AO_PORT = "3001";
    process.env.ZAPBOT_API_KEY = "api-key";
    process.env.ZAPBOT_REPO = "owner/repo";
    process.env.ZAPBOT_WEBHOOK_SECRET = "webhook-secret";
    process.env.ZAPBOT_GITHUB_TOKEN = "gh-token";

    const runtime = await Effect.runPromise(createConfigService().loadHostedBridgeRuntime());
    expect(runtime.routes.has("owner/repo")).toBe(true);
    expect(runtime.githubAuth._tag).toBe("GitHubPat");
  });

  it("fails hosted bridge runtime when HOME is missing", async () => {
    delete process.env.HOME;
    process.env.ZAPBOT_CHECKOUT_PATH = checkoutPath;
    process.env.ZAPBOT_PORT = "3000";
    process.env.ZAPBOT_AO_PORT = "3001";
    process.env.ZAPBOT_API_KEY = "api-key";
    process.env.ZAPBOT_REPO = "owner/repo";
    process.env.ZAPBOT_WEBHOOK_SECRET = "webhook-secret";
    process.env.ZAPBOT_GITHUB_TOKEN = "gh-token";

    const result = await Effect.runPromise(Effect.either(createConfigService().loadHostedBridgeRuntime()));
    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "ZapbotHomeMissing",
      });
    }
  });

  it("bootstrap stores project config under ~/.zapbot/projects/<key>/project.json", async () => {
    const receipt = await Effect.runPromise(initializeProjectConfig({
      checkoutPath,
      repo: "owner/repo",
    }));

    mkdirSync(join(fakeHome, ".zapbot"), { recursive: true });
    expect(receipt.projectHomePath.startsWith(join(fakeHome, ".zapbot", "projects"))).toBe(true);
    expect(receipt.configPath.endsWith("/project.json")).toBe(true);
  });

  it("bootstrap fails closed when HOME is missing", async () => {
    delete process.env.HOME;

    const result = await Effect.runPromise(Effect.either(initializeProjectConfig({
      checkoutPath,
      repo: "owner/repo",
    })));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "BootstrapConfigWriteFailed",
      });
      expect(result.left.cause).toContain("HOME must be set");
    }
  });
});
