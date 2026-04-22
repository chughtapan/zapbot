import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.join(__dirname, "..");

describe("canonical launch and reload surface", () => {
  it("start.sh is a thin wrapper over the typed launcher", () => {
    const startSh = fs.readFileSync(path.join(REPO_ROOT, "start.sh"), "utf8");
    expect(startSh).toContain('exec bun "$ZAPBOT_DIR/bin/zapbot-launch.ts" --checkout "$PROJECT_DIR"');
    expect(startSh).not.toContain("agent-orchestrator.yaml");
    expect(startSh).not.toContain('source "$PROJECT_DIR/.env"');
    expect(startSh).not.toContain('source "$HOME/.zapbot/.env"');
  });

  it("webhook-bridge reloads through the typed config service", () => {
    const bridge = fs.readFileSync(path.join(REPO_ROOT, "bin/webhook-bridge.ts"), "utf8");
    expect(bridge).toContain('process.on("SIGHUP"');
    expect(bridge).toContain("createConfigService");
    expect(bridge).toContain("loadBridgeRuntime");
    expect(bridge).not.toContain("parseEnvFile");
    expect(bridge).not.toContain("resolveRuntimeEnv(process.env");
    expect(bridge).not.toContain("process.env[key] = value");
  });

  it("zapbot-publish no longer sources local env files", () => {
    const publish = fs.readFileSync(path.join(REPO_ROOT, "bin/zapbot-publish.sh"), "utf8");
    expect(publish).not.toContain(".env");
    expect(publish).not.toContain("source");
  });
});
