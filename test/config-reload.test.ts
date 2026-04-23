import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  buildLauncherEnv,
  launchManagedProcesses,
  reloadManagedProcesses,
  resolveBridgeScriptPath,
} from "../bin/zapbot-launch.ts";
import {
  aoWebhookSecretEnvVar,
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
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(signal?: number | NodeJS.Signals): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    return true;
  }

  exit(code = 0): void {
    this.exitCode = code;
    this.emit("exit", code);
    this.emit("close", code);
  }
}

describe("launcher/runtime integration surface", () => {
  it("spawns the bridge from the launcher path", async () => {
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
    expect(calls[1]?.env?.[aoWebhookSecretEnvVar(asRepoFullName("owner/repo"))]).toBe("webhook-secret");

    const cleanupPromise = launched.cleanup();
    ao.exit(0);
    bridge.exit(0);
    await cleanupPromise;
    expect(ao.signals).toEqual(["SIGTERM"]);
    expect(bridge.signals).toEqual(["SIGTERM"]);
    expect(disposed).toBe(false);
  });

  it("waits for the old pair to exit before disposing AO runtime or spawning replacements", async () => {
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime({
      projectHomeCheckoutPath: "/srv/worktrees/secondary",
      routes: [
        {
          repo: "owner/repo",
          projectName: "repo",
          checkoutPath: "/srv/worktrees/secondary",
          webhookSecret: "updated-secret",
        },
        {
          repo: "owner/extra-repo",
          projectName: "extra-repo",
          checkoutPath: "/srv/worktrees/extra",
          webhookSecret: "extra-secret",
        },
      ],
    });
    let disposedFirst = false;
    const firstAoRuntime = {
      configPath: "/tmp/zapbot/first.yaml",
      registryPath: "/tmp/zapbot/first-registry.json",
      dispose: Effect.sync(() => {
        disposedFirst = true;
      }),
    };
    const secondAoRuntime = {
      configPath: "/tmp/zapbot/second.yaml",
      registryPath: "/tmp/zapbot/second-registry.json",
      dispose: Effect.sync(() => undefined),
    };
    const children = Array.from({ length: 4 }, () => new FakeChildProcess());
    const calls: Array<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
    const spawnImpl: typeof import("node:child_process").spawn = ((command, args, options) => {
      calls.push({
        command,
        args: [...args],
        cwd: options?.cwd,
        env: options?.env as NodeJS.ProcessEnv,
      });
      return children[calls.length - 1] as never;
    }) as never;

    const launched = launchManagedProcesses(firstRuntime, firstAoRuntime, {
      spawnImpl,
      bridgeScriptPath: "/srv/zapbot/bin/webhook-bridge.ts",
      bunBinary: "/usr/local/bin/bun",
    });
    const reloadedPromise = reloadManagedProcesses(launched, firstAoRuntime, {
      runtime: secondRuntime,
      aoRuntime: secondAoRuntime,
    }, {
      spawnImpl,
      bridgeScriptPath: "/srv/zapbot/bin/webhook-bridge.ts",
      bunBinary: "/usr/local/bin/bun",
    });

    expect(children[0]?.signals).toEqual(["SIGTERM"]);
    expect(children[1]?.signals).toEqual(["SIGTERM"]);
    expect(disposedFirst).toBe(false);
    expect(calls).toHaveLength(2);

    await Promise.resolve();
    children[0]?.exit(0);
    await Promise.resolve();
    expect(disposedFirst).toBe(false);
    expect(calls).toHaveLength(2);

    children[1]?.exit(0);
    const reloaded = await reloadedPromise;

    expect(disposedFirst).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[2]).toMatchObject({
      command: "ao",
      args: ["start"],
      cwd: "/srv/worktrees/secondary",
    });
    expect(calls[3]).toMatchObject({
      command: "/usr/local/bin/bun",
      args: ["/srv/zapbot/bin/webhook-bridge.ts", "--checkout", "/srv/worktrees/secondary"],
      cwd: "/srv/worktrees/secondary",
    });
    expect(calls[3]?.env?.AO_CONFIG_PATH).toBe("/tmp/zapbot/second.yaml");
    expect(calls[3]?.env?.ZAPBOT_MANAGED_SESSION_REGISTRY_PATH).toBe("/tmp/zapbot/second-registry.json");
    expect(calls[3]?.env?.[aoWebhookSecretEnvVar(asRepoFullName("owner/repo"))]).toBe("updated-secret");
    expect(calls[3]?.env?.[aoWebhookSecretEnvVar(asRepoFullName("owner/extra-repo"))]).toBe("extra-secret");

    const reloadedAo = children[2];
    const reloadedBridge = children[3];
    const cleanupPromise = reloaded.cleanup();
    reloadedAo?.exit(0);
    reloadedBridge?.exit(0);
    await cleanupPromise;
  });

  it("builds a coherent AO runtime env and generated config for multi-repo projects", async () => {
    const runtime = createRuntime();
    const aoRuntime = await Effect.runPromise(materializeAoRuntime(runtime));

    try {
      const env = buildLauncherEnv(runtime, aoRuntime, { PATH: "/usr/bin" });
      const yamlText = readFileSync(aoRuntime.configPath, "utf8");

      expect(env.AO_CONFIG_PATH).toBe(aoRuntime.configPath);
      expect(env.ZAPBOT_MANAGED_SESSION_REGISTRY_PATH).toBe(
        "/srv/operator/.zapbot/projects/demo/state/.zapbot-managed-sessions.json",
      );
      expect(env[aoWebhookSecretEnvVar(asRepoFullName("owner/repo"))]).toBe("webhook-secret");
      expect(env[aoWebhookSecretEnvVar(asRepoFullName("owner/second-repo"))]).toBe("second-secret");
      expect(yamlText).toContain("path: /srv/worktrees/repo");
      expect(yamlText).toContain("path: /srv/worktrees/second");
      expect(yamlText).toContain(`secretEnvVar: ${aoWebhookSecretEnvVar(asRepoFullName("owner/repo"))}`);
      expect(yamlText).toContain(`secretEnvVar: ${aoWebhookSecretEnvVar(asRepoFullName("owner/second-repo"))}`);
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

function createRuntime(overrides: {
  readonly projectHomeCheckoutPath?: string;
  readonly routes?: ReadonlyArray<{
    readonly repo: string;
    readonly projectName: string;
    readonly checkoutPath: string;
    readonly webhookSecret: string;
  }>;
} = {}): ResolvedProjectRuntime {
  return {
    projectHome: {
      projectKey: asProjectKey("demo"),
      homePath: asOperatorProjectHomePath("/srv/operator/.zapbot/projects/demo"),
      checkoutPath: asRepoCheckoutPath(overrides.projectHomeCheckoutPath ?? "/srv/worktrees/repo"),
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
      ...(overrides.routes ?? [
        {
          repo: "owner/repo",
          projectName: "repo",
          checkoutPath: "/srv/worktrees/repo",
          webhookSecret: "webhook-secret",
        },
        {
          repo: "owner/second-repo",
          projectName: "second-repo",
          checkoutPath: "/srv/worktrees/second",
          webhookSecret: "second-secret",
        },
      ]).map((route) => [
        asRepoFullName(route.repo),
        {
          projectName: asProjectName(route.projectName),
          repo: asRepoFullName(route.repo),
          checkoutPath: asRepoCheckoutPath(route.checkoutPath),
          defaultBranch: "main",
          webhookSecret: route.webhookSecret,
        },
      ]),
    ]),
  };
}
