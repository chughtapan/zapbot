import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const TEMPLATE_PATH = path.join(__dirname, "../templates/zapbot-bridge.service");

describe("systemd service template", () => {
  it("template file exists", () => {
    expect(fs.existsSync(TEMPLATE_PATH)).toBe(true);
  });

  it("contains required systemd sections", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("[Unit]");
    expect(content).toContain("[Service]");
    expect(content).toContain("[Install]");
  });

  it("uses placeholder variables for paths", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("__PROJECT_DIR__");
    expect(content).toContain("__ZAPBOT_DIR__");
  });

  it("supports SIGHUP reload via ExecReload", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("ExecReload=/bin/kill -HUP $MAINPID");
  });

  it("auto-restarts on crash", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("Restart=always");
  });

  it("loads secrets from config.json via ExecStartPre and keeps legacy .env as optional fallback", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("ExecStartPre=");
    expect(content).toContain("config.json");
    expect(content).toContain("ZAPBOT_WEBHOOK_SECRET");
    expect(content).toContain("ZAPBOT_API_KEY");
    // Legacy .env is optional (- prefix) so missing file does not abort the service
    expect(content).toContain("EnvironmentFile=-__PROJECT_DIR__/.env");
  });

  it("runs webhook-bridge.ts via bun", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("bun __ZAPBOT_DIR__/bin/webhook-bridge.ts");
  });

  it("placeholders can be replaced to produce valid paths", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    const resolved = content
      .replace(/__PROJECT_DIR__/g, "/home/user/project")
      .replace(/__ZAPBOT_DIR__/g, "/home/user/.claude/skills/zapbot");
    expect(resolved).toContain("WorkingDirectory=/home/user/project");
    expect(resolved).toContain("EnvironmentFile=-/home/user/project/.env");
    expect(resolved).toContain("bun /home/user/.claude/skills/zapbot/bin/webhook-bridge.ts");
    expect(resolved).not.toContain("__");
  });
});
