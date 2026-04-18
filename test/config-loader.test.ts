import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resolveWebhookSecret, type RepoMap } from "../src/config/loader.js";

// ── loadConfig ─────────────────────────────────────────────────────

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zapbot-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ZAPBOT_REPO;
  });

  it("parses a valid agent-orchestrator.yaml", () => {
    const yaml = `
port: 3000
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
`;
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, yaml);

    const { config, repoMap } = loadConfig(configPath);
    expect(config).not.toBeNull();
    expect(config!.port).toBe(3000);
    expect(repoMap.size).toBe(1);
    expect(repoMap.has("chughtapan/zapbot")).toBe(true);
    expect(repoMap.get("chughtapan/zapbot")!.projectName).toBe("zapbot");
  });

  it("builds repo map for multiple projects", () => {
    const yaml = `
port: 3000
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
  frontend:
    repo: chughtapan/frontend-app
    path: /home/user/frontend
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_API_KEY_FRONTEND
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
`;
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, yaml);

    const { repoMap } = loadConfig(configPath);
    expect(repoMap.size).toBe(2);
    expect(repoMap.get("chughtapan/zapbot")!.projectName).toBe("zapbot");
    expect(repoMap.get("chughtapan/frontend-app")!.projectName).toBe("frontend");
  });

  it("falls back to ZAPBOT_REPO env var when no config path", () => {
    process.env.ZAPBOT_REPO = "owner/my-repo";
    const { config, repoMap } = loadConfig();
    expect(config).toBeNull();
    expect(repoMap.size).toBe(1);
    expect(repoMap.has("owner/my-repo")).toBe(true);
    expect(repoMap.get("owner/my-repo")!.projectName).toBe("my-repo");
  });

  it("returns empty repoMap when no config and no env var", () => {
    delete process.env.ZAPBOT_REPO;
    const { config, repoMap } = loadConfig();
    expect(config).toBeNull();
    expect(repoMap.size).toBe(0);
  });

  it("throws on invalid config file path", () => {
    expect(() => loadConfig("/nonexistent/path.yaml")).toThrow("Cannot load config");
  });
});

// ── resolveWebhookSecret ───────────────────────────────────────────

describe("resolveWebhookSecret", () => {
  const sharedSecret = "shared-secret-123";

  function buildRepoMap(entries: Array<{ repo: string; projectName: string; secretEnvVar: string }>): RepoMap {
    const map = new Map();
    for (const e of entries) {
      map.set(e.repo, {
        projectName: e.projectName,
        config: {
          repo: e.repo,
          path: "/tmp",
          defaultBranch: "main",
          scm: {
            plugin: "github",
            webhook: {
              path: "/api/webhooks/github",
              secretEnvVar: e.secretEnvVar,
              signatureHeader: "x-hub-signature-256",
              eventHeader: "x-github-event",
            },
          },
        },
      });
    }
    return map;
  }

  afterEach(() => {
    delete process.env.ZAPBOT_API_KEY_FRONTEND;
  });

  it("returns shared secret for unknown repo", () => {
    const map = buildRepoMap([]);
    expect(resolveWebhookSecret("unknown/repo", map, sharedSecret)).toBe(sharedSecret);
  });

  it("returns shared secret when repo uses ZAPBOT_API_KEY", () => {
    const map = buildRepoMap([
      { repo: "owner/repo", projectName: "repo", secretEnvVar: "ZAPBOT_API_KEY" },
    ]);
    expect(resolveWebhookSecret("owner/repo", map, sharedSecret)).toBe(sharedSecret);
  });

  it("returns per-repo secret when configured and env var is set", () => {
    process.env.ZAPBOT_API_KEY_FRONTEND = "frontend-secret-456";
    const map = buildRepoMap([
      { repo: "owner/frontend", projectName: "frontend", secretEnvVar: "ZAPBOT_API_KEY_FRONTEND" },
    ]);
    expect(resolveWebhookSecret("owner/frontend", map, sharedSecret)).toBe("frontend-secret-456");
  });

  it("falls back to shared secret when per-repo env var is not set", () => {
    const map = buildRepoMap([
      { repo: "owner/frontend", projectName: "frontend", secretEnvVar: "ZAPBOT_API_KEY_FRONTEND" },
    ]);
    expect(resolveWebhookSecret("owner/frontend", map, sharedSecret)).toBe(sharedSecret);
  });
});
