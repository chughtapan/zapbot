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
  let fakeHome: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "zapbot-team-init-project-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "zapbot-team-init-bin-"));
    fakeHome = mkdtempSync(join(tmpdir(), "zapbot-team-init-home-"));

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
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("registers the repo in ~/.zapbot/projects.json with the orchestrator schema", () => {
    execTeamInit(["owner/example-repo"], projectDir, fakeBinDir, fakeHome);

    const projectsJsonPath = join(fakeHome, ".zapbot", "projects.json");
    const configJsonPath = join(fakeHome, ".zapbot", "config.json");

    expect(existsSync(projectsJsonPath)).toBe(true);
    expect(existsSync(configJsonPath)).toBe(true);

    const projects = JSON.parse(readFileSync(projectsJsonPath, "utf8")) as Record<
      string,
      { repo: string; defaultBranch: string }
    >;
    expect(projects["example-repo"]).toEqual({
      repo: "owner/example-repo",
      defaultBranch: "main",
    });

    const configJson = JSON.parse(readFileSync(configJsonPath, "utf8")) as Record<string, unknown>;
    expect(typeof configJson.webhookSecret).toBe("string");
    expect((configJson.webhookSecret as string).length).toBeGreaterThan(0);
    expect(typeof configJson.apiKey).toBe("string");
    expect((configJson.apiKey as string).length).toBeGreaterThan(0);
  });

  it("appends add-repo entries to ~/.zapbot/projects.json", () => {
    execTeamInit(["owner/example-repo"], projectDir, fakeBinDir, fakeHome);
    execTeamInit(["--add-repo", "owner/second-repo"], projectDir, fakeBinDir, fakeHome);

    const projects = JSON.parse(
      readFileSync(join(fakeHome, ".zapbot", "projects.json"), "utf8"),
    ) as Record<string, { repo: string; defaultBranch: string }>;

    expect(projects["example-repo"]).toEqual({
      repo: "owner/example-repo",
      defaultBranch: "main",
    });
    expect(projects["second-repo"]).toEqual({
      repo: "owner/second-repo",
      defaultBranch: "main",
    });
  });

  it("rejects --add-repo when the slug is already registered", () => {
    execTeamInit(["owner/example-repo"], projectDir, fakeBinDir, fakeHome);

    let stderr = "";
    try {
      execTeamInit(["--add-repo", "owner/example-repo"], projectDir, fakeBinDir, fakeHome);
    } catch (error) {
      stderr =
        String((error as { stdout?: unknown; stderr?: unknown }).stdout ?? "") +
        String((error as { stdout?: unknown; stderr?: unknown }).stderr ?? "");
    }

    expect(stderr).toContain("already registered");
  });
});

function execTeamInit(args: string[], cwd: string, fakeBinDir: string, fakeHome: string): void {
  execFileSync("bash", [SCRIPT_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    },
    stdio: "pipe",
  });
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}
