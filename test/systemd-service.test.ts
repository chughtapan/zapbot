import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

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

  it("uses the typed launcher and does not reference checkout-local env files", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("bun __ZAPBOT_DIR__/bin/zapbot-launch.ts --checkout __PROJECT_DIR__");
    expect(content).not.toContain("EnvironmentFile=");
    expect(content).not.toContain("webhook-bridge.ts");
  });

  it("supports SIGHUP reload via ExecReload", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("ExecReload=/bin/kill -HUP $MAINPID");
  });

  it("auto-restarts on crash", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    expect(content).toContain("Restart=always");
  });

  it("placeholders can be replaced to produce valid paths", () => {
    const content = fs.readFileSync(TEMPLATE_PATH, "utf-8");
    const resolved = content
      .replace(/__PROJECT_DIR__/g, "/home/user/project")
      .replace(/__ZAPBOT_DIR__/g, "/home/user/.claude/skills/zapbot");
    expect(resolved).toContain("WorkingDirectory=/home/user/project");
    expect(resolved).toContain("bun /home/user/.claude/skills/zapbot/bin/zapbot-launch.ts --checkout /home/user/project");
    expect(resolved).not.toContain("__");
  });
});
