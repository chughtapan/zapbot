import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseEnvFile, resolveRuntimeEnv } from "../src/config/env.js";
import { reloadBridgeRuntimeConfig } from "../src/config/reload.js";
import { loadBridgeRuntimeConfig } from "../src/config/load.js";
import { readConfigFiles, type ConfigDiskReader } from "../src/config/disk.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ConfigDiskError } from "../src/config/types.js";
import type { Result } from "../src/types.js";

function expectOk<T, E>(result: Result<T, E>): T {
  if (result._tag === "Err") {
    throw new Error(JSON.stringify(result.error));
  }
  return result.value;
}

const nodeDiskReader: ConfigDiskReader = {
  readText(filePath) {
    try {
      return { _tag: "Ok", value: fs.readFileSync(filePath, "utf-8") };
    } catch (cause) {
      return {
        _tag: "Err",
        error: {
          _tag: "ConfigFileUnreadable",
          path: filePath,
          cause: String(cause),
        } satisfies ConfigDiskError,
      };
    }
  },
};

function buildRuntime(
  env: Record<string, string | undefined>,
) {
  const resolvedEnv = expectOk(resolveRuntimeEnv(env, null));
  return expectOk(loadBridgeRuntimeConfig(resolvedEnv, null, null));
}

describe("parseEnvFile", () => {
  it("parses simple key=value pairs", () => {
    const result = expectOk(parseEnvFile("FOO=bar\nBAZ=qux"));
    expect(result).toEqual({ values: { FOO: "bar", BAZ: "qux" } });
  });

  it("skips comment lines", () => {
    const result = expectOk(parseEnvFile("# comment\nFOO=bar\n# another"));
    expect(result).toEqual({ values: { FOO: "bar" } });
  });

  it("skips blank lines", () => {
    const result = expectOk(parseEnvFile("FOO=bar\n\n\nBAZ=qux\n"));
    expect(result).toEqual({ values: { FOO: "bar", BAZ: "qux" } });
  });

  it("handles values with equals signs", () => {
    const result = expectOk(parseEnvFile("URL=http://localhost:3000?key=val&other=1"));
    expect(result).toEqual({ values: { URL: "http://localhost:3000?key=val&other=1" } });
  });

  it("trims whitespace from keys", () => {
    const result = expectOk(parseEnvFile("  FOO  =bar"));
    expect(result).toEqual({ values: { FOO: "bar" } });
  });

  it("rejects malformed non-comment lines", () => {
    const result = parseEnvFile("FOO=bar\nNOT_VALID");
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("MalformedEnvLine");
    }
  });
});

describe("reloadBridgeRuntimeConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-reload-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects when the webhook secret rotates", () => {
    const current = buildRuntime({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "old-secret",
      ZAPBOT_REPO: "owner/repo",
    });
    const next = buildRuntime({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "new-secret",
      ZAPBOT_REPO: "owner/repo",
    });

    const result = expectOk(reloadBridgeRuntimeConfig(current, next));
    expect(result.secretRotated).toBe(true);
    expect(result.next.webhookSecret).toBe("new-secret");
  });

  it("detects when the webhook secret is unchanged", () => {
    const current = buildRuntime({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "same-secret",
      ZAPBOT_REPO: "owner/repo",
    });
    const next = buildRuntime({
      ZAPBOT_API_KEY: "api-key-123",
      ZAPBOT_WEBHOOK_SECRET: "same-secret",
      ZAPBOT_REPO: "owner/repo",
    });

    const result = expectOk(reloadBridgeRuntimeConfig(current, next));
    expect(result.secretRotated).toBe(false);
  });

  it("treats missing .env as optional when reading config files", () => {
    const configPath = path.join(tmpDir, "agent-orchestrator.yaml");
    fs.writeFileSync(configPath, "projects: {}\n");

    const result = expectOk(readConfigFiles({
      envFilePath: path.join(tmpDir, ".env") as never,
      projectConfigPath: configPath as never,
    }, nodeDiskReader));

    expect(result.envFileText).toBeNull();
    expect(result.projectConfigText).toContain("projects:");
  });

  it("returns a disk error when the project config file does not exist", () => {
    const result = readConfigFiles({
      envFilePath: null,
      projectConfigPath: path.join(tmpDir, "missing.yaml") as never,
    }, nodeDiskReader);

    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("ConfigFileUnreadable");
    }
  });

  it("resolves runtime env from parsed .env values", () => {
    const parsed = expectOk(parseEnvFile("ZAPBOT_API_KEY=api\nZAPBOT_WEBHOOK_SECRET=secret\nZAPBOT_REPO=org/my-app\n"));
    const result = expectOk(resolveRuntimeEnv({}, parsed));

    expect(result.apiKey).toBe("api");
    expect(result.webhookSecret).toBe("secret");
    expect(result.singleRepo).toBe("org/my-app");
  });
});

describe("systemd integration: setup --server service generation", () => {
  it("sed command produces valid service file from template", () => {
    const templatePath = path.join(__dirname, "../templates/zapbot-bridge.service");
    const template = fs.readFileSync(templatePath, "utf-8");

    const projectDir = "/home/user/my-project";
    const zapbotDir = "/home/user/.claude/skills/zapbot";

    const resolved = template
      .replace(/__PROJECT_DIR__/g, projectDir)
      .replace(/__ZAPBOT_DIR__/g, zapbotDir);

    expect(resolved).toContain(`WorkingDirectory=${projectDir}`);
    expect(resolved).toContain(`EnvironmentFile=${projectDir}/.env`);
    expect(resolved).toContain(`ExecStart=/usr/bin/env bun ${zapbotDir}/bin/webhook-bridge.ts`);
    expect(resolved).not.toContain("__PROJECT_DIR__");
    expect(resolved).not.toContain("__ZAPBOT_DIR__");
  });
});

describe("systemd integration: start.sh guard", () => {
  it("guard pattern matches systemctl exit codes correctly", () => {
    const startSh = fs.readFileSync(
      path.join(__dirname, "../start.sh"),
      "utf-8"
    );

    expect(startSh).toContain("systemctl is-active zapbot-bridge");
    expect(startSh).toContain("2>&1");
    expect(startSh).toMatch(/systemctl is-active zapbot-bridge.*\n[\s\S]*?exit 1/);
  });
});

describe("systemd integration: team-init reload", () => {
  it("team-init calls systemctl reload (not restart)", () => {
    const teamInit = fs.readFileSync(
      path.join(__dirname, "../bin/zapbot-team-init"),
      "utf-8"
    );

    expect(teamInit).toContain("systemctl reload zapbot-bridge");
    expect(teamInit).toContain("systemctl is-active zapbot-bridge");
  });

  it("team-init adapts next-steps message based on systemd state", () => {
    const teamInit = fs.readFileSync(
      path.join(__dirname, "../bin/zapbot-team-init"),
      "utf-8"
    );

    expect(teamInit).toContain("Bridge is running (systemd)");
    expect(teamInit).toContain("start.sh . to start the bridge");
  });
});

describe("SIGHUP handler: bridge registers signal handler", () => {
  it("webhook-bridge.ts registers SIGHUP handler", () => {
    const bridge = fs.readFileSync(
      path.join(__dirname, "../bin/webhook-bridge.ts"),
      "utf-8"
    );

    expect(bridge).toContain('process.on("SIGHUP"');
    expect(bridge).toContain("reloadBridgeRuntimeConfig");
  });
});
