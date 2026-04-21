import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "bin", "zapbot-team-init");

describe("zapbot-team-init", () => {
  let projectDir: string;
  let fakeBinDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "zapbot-team-init-project-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "zapbot-team-init-bin-"));

    writeExecutable(
      join(fakeBinDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "fake-user"
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "create" ]; then
  exit 0
fi
echo "unexpected gh args: $@" >&2
exit 1
`,
    );

    writeExecutable(
      join(fakeBinDir, "systemctl"),
      `#!/usr/bin/env bash
exit 1
`,
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it("writes config and env into the current project directory", () => {
    execTeamInit(["owner/example-repo"], projectDir, fakeBinDir);

    const configPath = join(projectDir, "agent-orchestrator.yaml");
    const envPath = join(projectDir, ".env");

    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(envPath)).toBe(true);

    const config = readFileSync(configPath, "utf8");
    expect(config).toContain("repo: owner/example-repo");
    expect(config).toContain(`path: ${projectDir}`);
    expect(config).toContain("name: claude-moltzap");
    expect(config).toContain(`path: ${REPO_ROOT}/worker/ao-plugin-agent-claude-moltzap`);
    expect(config).toContain("agent: claude-moltzap");

    const env = readFileSync(envPath, "utf8");
    expect(env).toContain("ZAPBOT_WEBHOOK_SECRET=");
    expect(env).toContain("ZAPBOT_API_KEY=");
  });

  it("appends add-repo entries to the project-local config file", () => {
    execTeamInit(["owner/example-repo"], projectDir, fakeBinDir);
    execTeamInit(["--add-repo", "owner/second-repo"], projectDir, fakeBinDir);

    const config = readFileSync(join(projectDir, "agent-orchestrator.yaml"), "utf8");
    expect(config).toContain("repo: owner/example-repo");
    expect(config).toContain("repo: owner/second-repo");
  });
});

function execTeamInit(args: string[], cwd: string, fakeBinDir: string): void {
  execFileSync("bash", [SCRIPT_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    },
    stdio: "pipe",
  });
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}
