import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  buildLauncherEnv,
  launchManagedProcesses,
  resolveBridgeScriptPath,
} from "../bin/zapbot-launch.ts";
import {
  AO_WEBHOOK_SECRET_ENV_VAR,
  materializeAoRuntime,
} from "../src/config/ao-runtime.ts";
import {
  asOperatorProjectHomePath,
  asProjectKey,
  asRepoCheckoutPath,
} from "../src/config/home.ts";
import type { ResolvedProjectRuntime } from "../src/config/schema.ts";
import { asBotUsername, asProjectName, asRepoFullName } from "../src/types.ts";

class FakeChildProcess extends EventEmitter {
  readonly signals: string[] = [];
  pid = 1;

  kill(signal?: number | NodeJS.Signals): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    return true;
  }
}

describe("launcher/runtime integration surface", () => {
  it("spawns the bridge from the launcher path and forwards reload to the live bridge process", async () => {
    const runtime = createRuntime();
    let disposed = false;
    const aoRuntime = {
      configPath: "/tmp/zapbot/agent-orchestrator.generated.yaml",
      registryPath: "/tmp/zapbot/.zapbot-managed-sessions.json",
      dispose: Effect.sync(() => {
        disposed = true;
      }),
    };
    const ao = new FakeChildProcess();
    const bridge = new FakeChildProcess();
    const calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];

    const launched = launchManagedProcesses(runtime, aoRuntime, {
      bunBinary: "/usr/local/bin/bun",
      bridgeScriptPath: "/srv/zapbot/bin/webhook-bridge.ts",
      spawnImpl(command, args, options) {
        calls.push({
          command,
          args: [...args],
          cwd: options.cwd,
          env: options.env as NodeJS.ProcessEnv,
        });
        return (calls.length === 1 ? ao : bridge) as never;
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      command: "ao",
      args: ["start"],
      cwd: "/srv/worktrees/repo",
    });
    expect(calls[1]).toMatchObject({
      command: "/usr/local/bin/bun",
      args: ["/srv/zapbot/bin/webhook-bridge.ts", "--checkout", "/srv/worktrees/repo"],
      cwd: "/srv/worktrees/repo",
    });
    expect(calls[1]?.env?.[AO_WEBHOOK_SECRET_ENV_VAR]).toBe("webhook-secret");

    launched.reload();
    expect(bridge.signals).toEqual(["SIGHUP"]);

    await launched.cleanup();
    expect(ao.signals).toEqual(["SIGTERM"]);
    expect(bridge.signals).toEqual(["SIGHUP", "SIGTERM"]);
    expect(disposed).toBe(true);
  });

  it("builds a coherent AO runtime env and generated config", async () => {
    const runtime = createRuntime();
    const aoRuntime = await Effect.runPromise(materializeAoRuntime(runtime));

    try {
      const env = buildLauncherEnv(runtime, aoRuntime, { PATH: "/usr/bin" });
      const yamlText = readFileSync(aoRuntime.configPath, "utf8");

      expect(env.AO_CONFIG_PATH).toBe(aoRuntime.configPath);
      expect(env.ZAPBOT_MANAGED_SESSION_REGISTRY_PATH).toBe(
        "/srv/operator/.zapbot/projects/demo/state/.zapbot-managed-sessions.json",
      );
      expect(env[AO_WEBHOOK_SECRET_ENV_VAR]).toBe("webhook-secret");
      expect(env.__CANONICAL_ZAPBOT_WEBHOOK_SECRET__).toBeUndefined();

      expect(yamlText).toContain(`secretEnvVar: ${AO_WEBHOOK_SECRET_ENV_VAR}`);
      expect(aoRuntime.registryPath).toBe(
        "/srv/operator/.zapbot/projects/demo/state/.zapbot-managed-sessions.json",
      );
    } finally {
      await Effect.runPromise(aoRuntime.dispose);
    }
  });

  it("resolves the bridge entrypoint relative to the launcher itself", () => {
    expect(resolveBridgeScriptPath("file:///opt/zapbot/bin/zapbot-launch.ts")).toBe(
      "/opt/zapbot/bin/webhook-bridge.ts",
    );
  });
});

function createRuntime(): ResolvedProjectRuntime {
  return {
    projectHome: {
      projectKey: asProjectKey("demo"),
      homePath: asOperatorProjectHomePath("/srv/operator/.zapbot/projects/demo"),
      checkoutPath: asRepoCheckoutPath("/srv/worktrees/repo"),
    },
    bridgePort: 3000,
    aoPort: 3001,
    botUsername: asBotUsername("zapbot[bot]"),
    ingress: {
      _tag: "LocalOnly",
      mode: "local-only",
      gatewayUrl: null,
      publicUrl: null,
      requiresReachablePublicUrl: false,
    },
    gatewaySecret: null,
    githubAuth: {
      _tag: "GitHubPat",
      token: "gh-token",
    },
    moltzap: {
      _tag: "MoltzapDisabled",
    },
    logLevel: "info",
    apiKey: "api-key",
    routes: new Map([
      [asRepoFullName("owner/repo"), {
        projectName: asProjectName("repo"),
        repo: asRepoFullName("owner/repo"),
        checkoutPath: asRepoCheckoutPath("/srv/worktrees/repo"),
        defaultBranch: "main",
        webhookSecret: "webhook-secret",
      }],
    ]),
  };
}
