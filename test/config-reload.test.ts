import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseEnvFile, reloadConfigFromDisk } from "../src/config/reload.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("parseEnvFile", () => {
  it("parses simple key=value pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comment lines", () => {
    const result = parseEnvFile("# comment\nFOO=bar\n# another");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("skips blank lines", () => {
    const result = parseEnvFile("FOO=bar\n\n\nBAZ=qux\n");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles values with equals signs", () => {
    const result = parseEnvFile("URL=http://localhost:3000?key=val&other=1");
    expect(result).toEqual({ URL: "http://localhost:3000?key=val&other=1" });
  });

  it("trims whitespace from keys", () => {
    const result = parseEnvFile("  FOO  =bar");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("returns empty object for empty input", () => {
    expect(parseEnvFile("")).toEqual({});
    expect(parseEnvFile("\n\n")).toEqual({});
  });
});

describe("reloadConfigFromDisk", () => {
  let tmpDir: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-reload-test-"));
    // Save env vars we'll modify
    originalEnv.ZAPBOT_API_KEY = process.env.ZAPBOT_API_KEY;
    originalEnv.ZAPBOT_REPO = process.env.ZAPBOT_REPO;
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reloads config from valid .env file", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "ZAPBOT_API_KEY=new-secret-123\nZAPBOT_REPO=owner/repo\n");

    const result = reloadConfigFromDisk(envFile, undefined, "old-secret");
    expect(result).not.toBeNull();
    expect(result!.config.webhookSecret).toBe("new-secret-123");
    expect(result!.secretRotated).toBe(true);
  });

  it("detects when secret has not rotated", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "ZAPBOT_API_KEY=same-secret\nZAPBOT_REPO=owner/repo\n");

    const result = reloadConfigFromDisk(envFile, undefined, "same-secret");
    expect(result).not.toBeNull();
    expect(result!.secretRotated).toBe(false);
  });

  it("returns null when ZAPBOT_API_KEY is empty after re-read", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "ZAPBOT_REPO=owner/repo\n");
    // Clear the env var so it's empty
    delete process.env.ZAPBOT_API_KEY;

    const result = reloadConfigFromDisk(envFile, undefined, "old-secret");
    expect(result).toBeNull();
  });

  it("returns null when config YAML fails to parse", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "ZAPBOT_API_KEY=valid-secret\n");

    const yamlFile = path.join(tmpDir, "agent-orchestrator.yaml");
    fs.writeFileSync(yamlFile, "this is: [not: valid: yaml: {{{}}}");

    const result = reloadConfigFromDisk(envFile, yamlFile, "old-secret");
    expect(result).toBeNull();
  });

  it("returns null when .env file does not exist", () => {
    const result = reloadConfigFromDisk(
      path.join(tmpDir, "nonexistent.env"),
      undefined,
      "old-secret"
    );
    expect(result).toBeNull();
  });

  it("works without envFilePath (config-only reload)", () => {
    process.env.ZAPBOT_API_KEY = "existing-secret";
    process.env.ZAPBOT_REPO = "owner/repo";

    const result = reloadConfigFromDisk(undefined, undefined, "old-secret");
    expect(result).not.toBeNull();
    expect(result!.config.webhookSecret).toBe("existing-secret");
    expect(result!.config.repoMap.size).toBe(1);
  });

  it("populates repoMap from ZAPBOT_REPO env var", () => {
    const envFile = path.join(tmpDir, ".env");
    fs.writeFileSync(envFile, "ZAPBOT_API_KEY=secret\nZAPBOT_REPO=org/my-app\n");

    const result = reloadConfigFromDisk(envFile, undefined, "secret");
    expect(result).not.toBeNull();
    expect(result!.config.repoMap.has("org/my-app")).toBe(true);
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

    // Verify paths are correct
    expect(resolved).toContain(`WorkingDirectory=${projectDir}`);
    expect(resolved).toContain(`EnvironmentFile=${projectDir}/.env`);
    expect(resolved).toContain(`ExecStart=/usr/bin/env bun ${zapbotDir}/bin/webhook-bridge.ts`);

    // No unresolved placeholders
    expect(resolved).not.toContain("__PROJECT_DIR__");
    expect(resolved).not.toContain("__ZAPBOT_DIR__");
  });
});

describe("systemd integration: start.sh guard", () => {
  it("guard pattern matches systemctl exit codes correctly", () => {
    // systemctl is-active returns:
    //   0 = active
    //   3 = inactive
    //   4 = no such unit
    // start.sh guards on exit code 0 only

    // We can't run systemctl in test, but we verify the script pattern
    const startSh = fs.readFileSync(
      path.join(__dirname, "../start.sh"),
      "utf-8"
    );

    // Must check specifically for zapbot-bridge service
    expect(startSh).toContain("systemctl is-active zapbot-bridge");

    // Must redirect stderr (handles missing systemctl gracefully)
    expect(startSh).toContain("2>&1");

    // Must exit (not just warn) to prevent port conflict
    expect(startSh).toMatch(/systemctl is-active zapbot-bridge.*\n[\s\S]*?exit 1/);
  });
});

describe("systemd integration: team-init reload", () => {
  it("team-init calls systemctl reload (not restart)", () => {
    const teamInit = fs.readFileSync(
      path.join(__dirname, "../bin/zapbot-team-init"),
      "utf-8"
    );

    // Must use reload (SIGHUP) not restart (kills process)
    expect(teamInit).toContain("systemctl reload zapbot-bridge");

    // Should check if service is active before trying to reload
    expect(teamInit).toContain("systemctl is-active zapbot-bridge");
  });

  it("team-init adapts next-steps message based on systemd state", () => {
    const teamInit = fs.readFileSync(
      path.join(__dirname, "../bin/zapbot-team-init"),
      "utf-8"
    );

    // Two different messages: one for systemd, one for manual start
    expect(teamInit).toContain("Bridge is running (systemd)");
    expect(teamInit).toContain("Run ./start.sh to start the bridge");
  });
});

describe("SIGHUP handler: bridge registers signal handler", () => {
  it("webhook-bridge.ts registers SIGHUP handler", () => {
    const bridge = fs.readFileSync(
      path.join(__dirname, "../bin/webhook-bridge.ts"),
      "utf-8"
    );

    expect(bridge).toContain('process.on("SIGHUP"');
    expect(bridge).toContain("reloadConfigFromDisk");
  });

  it("uses let (not const) for reloadable variables", () => {
    const bridge = fs.readFileSync(
      path.join(__dirname, "../bin/webhook-bridge.ts"),
      "utf-8"
    );

    // WEBHOOK_SECRET and repoMap must be let (not const) so SIGHUP can swap them
    expect(bridge).toMatch(/let WEBHOOK_SECRET/);
    expect(bridge).toMatch(/let \{ repoMap \}/);
  });
});
