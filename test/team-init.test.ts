import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = join(__dirname, "..");
const SCRIPT_PATH = join(REPO_ROOT, "bin", "zapbot-team-init");

describe("zapbot-team-init", () => {
  let projectDir: string;
  let secondProjectDir: string;
  let fakeBinDir: string;
  let fakeHome: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "zapbot-team-init-project-"));
    secondProjectDir = mkdtempSync(join(tmpdir(), "zapbot-team-init-project-"));
    fakeBinDir = mkdtempSync(join(tmpdir(), "zapbot-team-init-bin-"));
    fakeHome = mkdtempSync(join(tmpdir(), "zapbot-team-init-home-"));

    writeExecutable(
      join(fakeBinDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "label" ] && [ "$2" = "create" ]; then
  exit 0
fi
echo "unexpected gh args: $@" >&2
exit 1
`,
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(secondProjectDir, { recursive: true, force: true });
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("writes canonical project config under ~/.zapbot instead of the checkout", () => {
    execTeamInit(["owner/example-repo"], projectDir, fakeBinDir, fakeHome);

    const configPath = join(fakeHome, ".zapbot", "projects", "zapbot-team-init-project-", "project.json");
    const discoveredPath = findOnlyProjectConfig(fakeHome);

    expect(existsSync(join(projectDir, "agent-orchestrator.yaml"))).toBe(false);
    expect(existsSync(join(projectDir, ".env"))).toBe(false);
    expect(existsSync(discoveredPath)).toBe(true);

    const config = JSON.parse(readFileSync(discoveredPath, "utf8")) as {
      checkoutPath: string;
      routes: Array<{ repo: string; checkoutPath?: string }>;
      bridge: { apiKey: string };
    };
    expect(config.checkoutPath).toBe(projectDir);
    expect(config.routes.map((route) => route.repo)).toEqual(["owner/example-repo"]);
    expect(config.routes[0]?.checkoutPath).toBe(projectDir);
    expect(config.bridge.apiKey.length).toBeGreaterThan(10);

    void configPath;
  });

  it("appends add-repo entries with the current checkout bound per route", () => {
    const initOutput = execTeamInit(["owner/example-repo"], projectDir, fakeBinDir, fakeHome);
    const projectKey = parseProjectKey(initOutput);
    execTeamInit(["--project-key", projectKey, "--add-repo", "owner/second-repo"], secondProjectDir, fakeBinDir, fakeHome);

    const config = JSON.parse(readFileSync(findOnlyProjectConfig(fakeHome), "utf8")) as {
      routes: Array<{ repo: string; checkoutPath?: string }>;
    };
    expect(config.routes.map((route) => ({
      repo: route.repo,
      checkoutPath: route.checkoutPath,
    }))).toEqual([
      { repo: "owner/example-repo", checkoutPath: projectDir },
      { repo: "owner/second-repo", checkoutPath: secondProjectDir },
    ]);
  });

  it("fails closed when add-repo is run from an unbound checkout without --project-key", () => {
    execTeamInit(["owner/example-repo"], projectDir, fakeBinDir, fakeHome);

    expect(() => {
      execTeamInit(["--add-repo", "owner/second-repo"], secondProjectDir, fakeBinDir, fakeHome);
    }).toThrowError(/BootstrapProjectKeyRequired/);
  });
});

function execTeamInit(args: string[], cwd: string, fakeBinDir: string, fakeHome: string): string {
  return execFileSync("bash", [SCRIPT_PATH, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: fakeHome,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    },
    stdio: "pipe",
    encoding: "utf8",
  });
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, "utf8");
  chmodSync(path, 0o755);
}

function findOnlyProjectConfig(fakeHome: string): string {
  const projectsRoot = join(fakeHome, ".zapbot", "projects");
  const projectDirs = readdirSync(projectsRoot);
  if (projectDirs.length !== 1) {
    throw new Error(`expected one project dir, found ${projectDirs.length}`);
  }
  return join(projectsRoot, projectDirs[0]!, "project.json");
}

function parseProjectKey(output: string): string {
  const match = /Initialized\s+([^\s]+)\s+under/.exec(output);
  if (!match?.[1]) {
    throw new Error(`missing project key in output: ${output}`);
  }
  return match[1];
}
