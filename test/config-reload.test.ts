import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseEnvFile, resolveRuntimeEnv } from "../src/config/env.js";
import { resolveIngressPolicy } from "../src/config/ingress.js";
import { reloadBridgeRuntimeConfig } from "../src/config/reload.js";
import { loadBridgeRuntimeConfig } from "../src/config/load.js";
import { readConfigFiles, type ConfigDiskReader } from "../src/config/disk.js";
import { execFileSync } from "child_process";
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
  return expectOk(loadBridgeRuntimeConfig(resolvedEnv, null, null, {
    _tag: "LocalOnly",
    mode: "local-only",
    gatewayUrl: null,
    publicUrl: null,
    requiresReachablePublicUrl: false,
  }));
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

describe("resolveIngressPolicy", () => {
  it("allows local-only startup without a public bridge url", async () => {
    let called = false;
    const result = await resolveIngressPolicy({
      mode: "local-only",
      gatewayUrl: "",
      publicUrl: null,
      isPublicUrlReachable: async () => {
        called = true;
        return false;
      },
    });

    expect(result._tag).toBe("Ok");
    expect(called).toBe(false);
    if (result._tag === "Ok") {
      expect(result.value).toMatchObject({
        _tag: "LocalOnly",
        mode: "local-only",
        gatewayUrl: null,
        publicUrl: null,
        requiresReachablePublicUrl: false,
      });
    }
  });

  it("fails demo mode when the public bridge url is missing", async () => {
    const result = await resolveIngressPolicy({
      mode: "github-demo",
      gatewayUrl: "https://gateway.example",
      publicUrl: null,
      isPublicUrlReachable: async () => true,
    });

    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "MissingPublicBridgeUrl" },
    });
  });

  it("fails demo mode when the public bridge url is unreachable", async () => {
    const result = await resolveIngressPolicy({
      mode: "github-demo",
      gatewayUrl: "https://gateway.example",
      publicUrl: "https://bridge.example",
      isPublicUrlReachable: async () => false,
    });

    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "UnreachablePublicBridgeUrl", publicUrl: "https://bridge.example" },
    });
  });

  it("accepts demo mode only when the public bridge url is reachable", async () => {
    const result = await resolveIngressPolicy({
      mode: "github-demo",
      gatewayUrl: "https://gateway.example",
      publicUrl: "https://bridge.example",
      isPublicUrlReachable: async () => true,
    });

    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value).toMatchObject({
        _tag: "GitHubDemo",
        mode: "github-demo",
        gatewayUrl: "https://gateway.example",
        publicUrl: "https://bridge.example",
        requiresReachablePublicUrl: true,
      });
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

  it("loads shared env before project env so checkout-local secrets win", () => {
    const startSh = fs.readFileSync(
      path.join(__dirname, "../start.sh"),
      "utf-8"
    );

    const sharedIndex = startSh.indexOf('source "$HOME/.zapbot/.env"');
    const projectIndex = startSh.indexOf('source "$PROJECT_DIR/.env"');

    expect(sharedIndex).toBeGreaterThanOrEqual(0);
    expect(projectIndex).toBeGreaterThanOrEqual(0);
    expect(sharedIndex).toBeLessThan(projectIndex);
  });

  it("retries once after a duplicate orchestrator session is reported", () => {
    const repoRoot = path.join(__dirname, "..");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-start-retry-"));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-start-home-"));
    const projectDir = path.join(tempRoot, "project");
    const fakeBinDir = path.join(tempRoot, "bin");
    const tmuxLog = path.join(tempRoot, "tmux.log");
    const aoCallsLog = path.join(tempRoot, "ao-calls.log");
    const realBun = execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(path.join(tempHome, ".zapbot"), { recursive: true });

    try {
      writeFile(
        path.join(projectDir, "agent-orchestrator.yaml"),
        [
          "projects:",
          "  demo:",
          "    repo: owner/repo",
          "    path: " + projectDir,
          "    defaultBranch: main",
          "    scm:",
          "      plugin: github",
          "      webhook:",
          "        path: /api/webhooks/github",
          "        secretEnvVar: ZAPBOT_WEBHOOK_SECRET",
          "        signatureHeader: x-hub-signature-256",
          "        eventHeader: x-github-event",
          "",
        ].join("\n"),
      );
      writeFile(
        path.join(projectDir, ".env"),
        [
          "# project-local secrets must win",
          "ZAPBOT_API_KEY=project-api-key",
          "ZAPBOT_WEBHOOK_SECRET=project-webhook-secret",
          "",
        ].join("\n"),
      );
      writeFile(
        path.join(tempHome, ".zapbot", ".env"),
        [
          "# shared state intentionally stale",
          "ZAPBOT_API_KEY=shared-api-key",
          "ZAPBOT_WEBHOOK_SECRET=shared-webhook-secret",
          "",
        ].join("\n"),
      );
      writeFile(
        path.join(projectDir, ".zapbot-managed-sessions.json"),
        JSON.stringify({
          version: 1,
          records: [
            {
              id: "demo-orchestrator-1",
              tag: {
                managed: true,
                owner: "zapbot",
                projectName: "demo",
                sessionName: "demo-orchestrator-1",
                scope: "orchestrator",
                origin: "start.sh",
                claimedAtMs: Date.now(),
              },
              tmuxName: "demo-orchestrator-1",
              worktree: projectDir,
              processId: null,
              phase: "active",
              lastHeartbeatAtMs: Date.now(),
            },
          ],
        }, null, 2) + "\n",
      );
      writeFile(tmuxLog, "");
      writeFile(aoCallsLog, "");

      writeExecutable(
        path.join(fakeBinDir, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "fake-user"
  exit 0
fi
echo "unexpected gh args: $@" >&2
exit 1
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "systemctl"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "is-active" ]; then
  exit 1
fi
exit 0
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "tmux"),
        `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "\${TMUX_LOG}"
if [ "$1" = "kill-session" ]; then
  exit 0
fi
exit 0
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "ao"),
        `#!/usr/bin/env bash
set -euo pipefail
STATE_FILE="\${AO_CONFIG_PATH}.count"
COUNT=0
if [ -f "$STATE_FILE" ]; then
  COUNT=$(cat "$STATE_FILE")
fi
if [ "$1" = "start" ]; then
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "$STATE_FILE"
  echo "start $COUNT $*" >> "\${AO_CALLS_LOG}"
  if [ "$COUNT" -eq 1 ]; then
    echo "Failed to setup orchestrator: duplicate session: demo-orchestrator-1"
    exit 1
  fi
  echo "Dashboard starting on http://localhost:3002"
  trap 'exit 0' TERM INT
  sleep 2
  exit 0
fi
if [ "$1" = "status" ]; then
  echo '[]'
  exit 0
fi
echo "unexpected ao args: $@" >&2
exit 1
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "bun"),
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == *"resolve-managed-startup-retry.ts" ]]; then
  exec "${realBun}" "$@"
fi
trap 'exit 0' TERM INT
sleep 2
exit 0
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  *"/api/observability")
    echo '{"overallStatus":"ok"}'
    exit 0
    ;;
  *"/healthz")
    exit 0
    ;;
esac
exit 0
`,
      );

      const output = execFileSync("bash", [path.join(repoRoot, "start.sh"), "."], {
        cwd: projectDir,
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          TMUX_LOG: tmuxLog,
          AO_CALLS_LOG: aoCallsLog,
        },
        encoding: "utf8",
      });

      expect(output).toContain("Detected duplicate managed orchestrator session demo-orchestrator-1; retrying startup...");
      expect(output).toContain("AO ready on port 3002");
      expect(output).toContain("Bridge ready on port 3000");
      expect(fs.readFileSync(tmuxLog, "utf8")).not.toContain("kill-session");
      expect(fs.readFileSync(aoCallsLog, "utf8")).toContain("start 1");
      expect(fs.readFileSync(aoCallsLog, "utf8")).toContain("start 2");
      expect(fs.readFileSync(path.join(projectDir, "agent-orchestrator.yaml"), "utf8")).toContain("repo: owner/repo");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("keeps local-only startup running even if a stale bridge url is present", () => {
    const repoRoot = path.join(__dirname, "..");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-bridge-explicit-"));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-bridge-home-"));
    const projectDir = path.join(tempRoot, "project");
    const fakeBinDir = path.join(tempRoot, "bin");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(path.join(tempHome, ".zapbot"), { recursive: true });

    try {
      writeFile(
        path.join(projectDir, "agent-orchestrator.yaml"),
        [
          "projects:",
          "  demo:",
          "    repo: owner/repo",
          "    path: " + projectDir,
          "    defaultBranch: main",
          "    scm:",
          "      plugin: github",
          "      webhook:",
          "        path: /api/webhooks/github",
          "        secretEnvVar: ZAPBOT_WEBHOOK_SECRET",
          "        signatureHeader: x-hub-signature-256",
          "        eventHeader: x-github-event",
          "",
        ].join("\n"),
      );
      writeFile(
        path.join(projectDir, ".env"),
        [
          "ZAPBOT_API_KEY=project-api-key",
          "ZAPBOT_WEBHOOK_SECRET=project-webhook-secret",
          "ZAPBOT_GATEWAY_URL=   ",
          "ZAPBOT_BRIDGE_URL=http://dead.example:3000",
          "",
        ].join("\n"),
      );

      writeExecutable(
        path.join(fakeBinDir, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "fake-user"
  exit 0
fi
echo "unexpected gh args: $@" >&2
exit 1
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "systemctl"),
        `#!/usr/bin/env bash
set -euo pipefail
exit 1
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "ao"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "start" ]; then
  echo "Dashboard starting on http://localhost:3002"
  trap 'exit 0' TERM INT
  sleep 2
  exit 0
fi
if [ "$1" = "status" ]; then
  echo '[]'
  exit 0
fi
echo "unexpected ao args: $@" >&2
exit 1
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "bun"),
        `#!/usr/bin/env bash
set -euo pipefail
trap 'exit 0' TERM INT
sleep 2
exit 0
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  http://localhost:3002/api/observability)
    echo '{"overallStatus":"ok"}'
    exit 0
    ;;
  http://localhost:3000/healthz)
    exit 0
    ;;
  http://dead.example:3000/healthz)
    exit 7
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 1
    ;;
esac
`,
      );

      const output = execFileSync("bash", [path.join(repoRoot, "start.sh"), "."], {
        cwd: projectDir,
        env: {
          ...process.env,
          HOME: tempHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      });

      expect(output).toContain("Mode:      local-only");
      expect(output).toContain("Gateway:   (local-only)");
      expect(output).toContain("Public:    (local-only)");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("fails closed in github demo mode when the public bridge url is dead", () => {
    const repoRoot = path.join(__dirname, "..");
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-bridge-demo-"));
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-bridge-demo-home-"));
    const projectDir = path.join(tempRoot, "project");
    const fakeBinDir = path.join(tempRoot, "bin");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(path.join(tempHome, ".zapbot"), { recursive: true });

    try {
      writeFile(
        path.join(projectDir, "agent-orchestrator.yaml"),
        [
          "projects:",
          "  demo:",
          "    repo: owner/repo",
          "    path: " + projectDir,
          "    defaultBranch: main",
          "    scm:",
          "      plugin: github",
          "      webhook:",
          "        path: /api/webhooks/github",
          "        secretEnvVar: ZAPBOT_WEBHOOK_SECRET",
          "        signatureHeader: x-hub-signature-256",
          "        eventHeader: x-github-event",
          "",
        ].join("\n"),
      );
      writeFile(
        path.join(projectDir, ".env"),
        [
          "ZAPBOT_API_KEY=project-api-key",
          "ZAPBOT_WEBHOOK_SECRET=project-webhook-secret",
          "ZAPBOT_GATEWAY_URL=https://gateway.example",
          "ZAPBOT_BRIDGE_URL=http://dead.example:3000",
          "",
        ].join("\n"),
      );

      writeExecutable(
        path.join(fakeBinDir, "gh"),
        `#!/usr/bin/env bash
set -euo pipefail
if [ "$1" = "api" ] && [ "$2" = "user" ]; then
  echo "fake-user"
  exit 0
fi
echo "unexpected gh args: $@" >&2
exit 1
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "systemctl"),
        `#!/usr/bin/env bash
set -euo pipefail
exit 1
`,
      );
      writeExecutable(
        path.join(fakeBinDir, "curl"),
        `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  http://dead.example:3000/healthz)
    exit 7
    ;;
  *)
    echo "unexpected curl url: $url" >&2
    exit 1
    ;;
esac
`,
      );

      let output = "";
      try {
        execFileSync("bash", [path.join(repoRoot, "start.sh"), "."], {
          cwd: projectDir,
          env: {
            ...process.env,
            HOME: tempHome,
            PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
          },
          encoding: "utf8",
        });
      } catch (error) {
        output = String((error as { stdout?: unknown; stderr?: unknown }).stdout ?? "") +
          String((error as { stdout?: unknown; stderr?: unknown }).stderr ?? "");
      }

      expect(output).toContain("ERROR: ZAPBOT_BRIDGE_URL is unreachable: http://dead.example:3000");
      expect(output).toContain("FIX: Do not rely on host-derived fallback; set ZAPBOT_BRIDGE_URL to a live public URL.");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
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

function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, "utf8");
}

function writeExecutable(filePath: string, content: string): void {
  writeFile(filePath, content);
  fs.chmodSync(filePath, 0o755);
}
