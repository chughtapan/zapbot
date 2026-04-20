import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  readConfigFiles,
  parseProjectConfig,
  type ConfigDiskReader,
} from "../src/config/disk.js";
import { resolveRuntimeEnv } from "../src/config/env.js";
import {
  deriveConfigSourcePaths,
  loadBridgeRuntimeConfig,
} from "../src/config/load.js";
import type { ConfigDiskError } from "../src/config/types.js";
import type { Result } from "../src/types.js";

function expectOk<T, E>(result: Result<T, E>): T {
  if (result._tag === "Err") {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}

const nodeDiskReader: ConfigDiskReader = {
  readText(path) {
    try {
      return { _tag: "Ok", value: readFileSync(path, "utf-8") };
    } catch (cause) {
      return {
        _tag: "Err",
        error: {
          _tag: "ConfigFileUnreadable",
          path,
          cause: String(cause),
        } satisfies ConfigDiskError,
      };
    }
  },
};

describe("config load pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "zapbot-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a valid agent-orchestrator.yaml into bridge runtime routes", () => {
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
        secretEnvVar: ZAPBOT_WEBHOOK_SECRET
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
`;
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, yaml);

    const document = expectOk(parseProjectConfig(configPath, yaml));
    const env = expectOk(resolveRuntimeEnv({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "webhook-secret-456",
      ZAPBOT_CONFIG: configPath,
    }, null));
    const runtime = expectOk(loadBridgeRuntimeConfig(env, null, document));

    expect(runtime.routes.size).toBe(1);
    expect(runtime.routes.has("chughtapan/zapbot")).toBe(true);
    expect(runtime.routes.get("chughtapan/zapbot")!.projectName).toBe("zapbot");
    expect(runtime.aoConfigPath).toBe(configPath);
  });

  it("builds runtime routes for multiple projects", () => {
    const yaml = `
projects:
  zapbot:
    repo: chughtapan/zapbot
    path: /home/user/zapbot
    defaultBranch: main
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_WEBHOOK_SECRET
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
  frontend:
    repo: chughtapan/frontend-app
    path: /home/user/frontend
    defaultBranch: trunk
    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: ZAPBOT_WEBHOOK_SECRET_FRONTEND
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event
`;

    const document = expectOk(parseProjectConfig("agent-orchestrator.yaml", yaml));
    const env = expectOk(resolveRuntimeEnv({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "webhook-secret-456",
    }, null));
    const runtime = expectOk(loadBridgeRuntimeConfig(env, null, document));

    expect(runtime.routes.size).toBe(2);
    expect(runtime.routes.get("chughtapan/zapbot")!.projectName).toBe("zapbot");
    expect(runtime.routes.get("chughtapan/frontend-app")!.projectName).toBe("frontend");
    expect(runtime.routes.get("chughtapan/frontend-app")!.defaultBranch).toBe("trunk");
  });

  it("retains the single-repo fallback when no project config is present", () => {
    const env = expectOk(resolveRuntimeEnv({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "webhook-secret-456",
      ZAPBOT_REPO: "owner/my-repo",
    }, null));
    const runtime = expectOk(loadBridgeRuntimeConfig(env, null, null));

    expect(runtime.routes.size).toBe(1);
    expect(runtime.routes.has("owner/my-repo")).toBe(true);
    expect(runtime.routes.get("owner/my-repo")!.projectName).toBe("my-repo");
  });

  it("returns empty routes when neither project config nor ZAPBOT_REPO is provided", () => {
    const env = expectOk(resolveRuntimeEnv({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "webhook-secret-456",
    }, null));
    const runtime = expectOk(loadBridgeRuntimeConfig(env, null, null));

    expect(runtime.routes.size).toBe(0);
  });

  it("derives .env next to the config path", () => {
    const paths = deriveConfigSourcePaths("/tmp/project/agent-orchestrator.yaml");
    expect(paths.projectConfigPath).toBe("/tmp/project/agent-orchestrator.yaml");
    expect(paths.envFilePath).toBe("/tmp/project/.env");
  });

  it("returns a disk error when the project config path is unreadable", () => {
    const result = readConfigFiles(
      deriveConfigSourcePaths("/nonexistent/path/agent-orchestrator.yaml"),
      nodeDiskReader,
    );

    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("ConfigFileUnreadable");
    }
  });

  it("rejects configs that still use ZAPBOT_API_KEY as the webhook secret env var", () => {
    const yaml = `
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

    const result = parseProjectConfig("agent-orchestrator.yaml", yaml);
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("DeprecatedSecretBinding");
    }
  });
});
