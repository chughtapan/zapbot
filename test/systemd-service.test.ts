import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TEMPLATE_PATH = join(__dirname, "../templates/zapbot-bridge.service");

describe("systemd service template", () => {
  it("renders a launcher-owned service topology", () => {
    const directives = parseUnitDirectives(renderTemplate({
      projectDir: "/home/user/project",
      zapbotDir: "/home/user/.zapbot/zapbot",
    }));

    expect(directives.WorkingDirectory).toBe("/home/user/project");
    expect(directives.ExecStart).toBe(
      "/usr/bin/env bun /home/user/.zapbot/zapbot/bin/zapbot-launch.ts --checkout /home/user/project",
    );
    expect(directives.ExecReload).toBe("/bin/kill -HUP $MAINPID");
    expect(directives.Restart).toBe("always");
    expect(directives.EnvironmentFile).toBeUndefined();
  });

  it("starts the launcher instead of invoking the bridge directly", () => {
    const directives = parseUnitDirectives(readFileSync(TEMPLATE_PATH, "utf8"));
    const execStart = directives.ExecStart ?? "";

    expect(execStart.includes("zapbot-launch.ts")).toBe(true);
    expect(execStart.includes("webhook-bridge.ts")).toBe(false);
  });
});

function renderTemplate(input: { readonly projectDir: string; readonly zapbotDir: string }): string {
  return readFileSync(TEMPLATE_PATH, "utf8")
    .replace(/__PROJECT_DIR__/g, input.projectDir)
    .replace(/__ZAPBOT_DIR__/g, input.zapbotDir);
}

function parseUnitDirectives(content: string): Record<string, string> {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("["))
    .reduce<Record<string, string>>((directives, line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        return directives;
      }
      directives[line.slice(0, separator)] = line.slice(separator + 1);
      return directives;
    }, {});
}
