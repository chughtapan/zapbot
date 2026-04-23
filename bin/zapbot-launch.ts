#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
  AO_WEBHOOK_SECRET_ENV_VAR,
  materializeAoRuntime,
  resolveAoWebhookSecret,
  resolveAoWebhookSecretBindings,
  type AoRuntimeHandle,
} from "../src/config/ao-runtime.ts";
import { asRepoCheckoutPath, type ProjectRef } from "../src/config/home.ts";
import { createConfigService } from "../src/config/service.ts";
import type { ResolvedProjectRuntime } from "../src/config/schema.ts";
import { buildMoltzapProcessEnv } from "../src/moltzap/runtime.ts";

interface LaunchArgs {
  readonly checkoutPath: string;
  readonly projectKey?: string;
}

interface LaunchSpawnOptions {
  readonly spawnImpl?: typeof spawn;
  readonly bridgeScriptPath?: string;
  readonly bunBinary?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

interface LaunchProcessTree {
  readonly ao: ReturnType<typeof spawn>;
  readonly bridge: ReturnType<typeof spawn>;
  readonly env: NodeJS.ProcessEnv;
  readonly cleanup: () => Promise<void>;
}

interface LoadedLaunchState {
  readonly runtime: ResolvedProjectRuntime;
  readonly aoRuntime: AoRuntimeHandle;
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const ref: ProjectRef = {
    checkoutPath: asRepoCheckoutPath(args.checkoutPath),
    ...(typeof args.projectKey === "string" ? { projectKey: args.projectKey as never } : {}),
  };
  let active = await loadLaunchState(ref);
  let launched = launchManagedProcesses(active.runtime, active.aoRuntime);
  let generation = 0;
  let settled = false;
  let reloading = false;
  let cleaningUp = false;

  const exitCode = await new Promise<number>((resolveExit) => {
    const watch = (tree: LaunchProcessTree, treeGeneration: number) => {
      for (const child of [tree.ao, tree.bridge]) {
        child.once("exit", (code) => {
          if (settled || reloading || cleaningUp || treeGeneration !== generation) {
            return;
          }
          settled = true;
          resolveExit(code ?? 0);
        });
        child.once("error", () => {
          if (settled || reloading || cleaningUp || treeGeneration !== generation) {
            return;
          }
          settled = true;
          resolveExit(1);
        });
      }
    };

    watch(launched, generation);

    const shutdown = (exitCode: number) => {
      void (async () => {
        if (settled || cleaningUp) {
          return;
        }
        settled = true;
        cleaningUp = true;
        await launched.cleanup();
        await Effect.runPromise(active.aoRuntime.dispose).catch(() => undefined);
        resolveExit(exitCode);
      })();
    };

    process.on("SIGINT", () => shutdown(0));
    process.on("SIGTERM", () => shutdown(0));
    process.on("SIGHUP", () => {
      void (async () => {
        if (settled || reloading || cleaningUp) {
          return;
        }
        reloading = true;
        try {
          const next = await loadLaunchState(ref);
          cleaningUp = true;
          launched = await reloadManagedProcesses(launched, active.aoRuntime, next);
          cleaningUp = false;
          active = next;
          generation += 1;
          watch(launched, generation);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
        } finally {
          reloading = false;
          cleaningUp = false;
        }
      })();
    });
  });

  cleaningUp = true;
  await launched.cleanup();
  await Effect.runPromise(active.aoRuntime.dispose).catch(() => undefined);
  process.exit(exitCode);
}

function parseArgs(argv: readonly string[]): LaunchArgs {
  let checkoutPath = process.cwd();
  let projectKey: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--checkout") {
      checkoutPath = argv[index + 1] ?? checkoutPath;
      index += 1;
      continue;
    }
    if (arg === "--project-key") {
      projectKey = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: bun run bin/zapbot-launch.ts [--checkout PATH] [--project-key KEY]\n");
      process.exit(0);
    }
  }

  return { checkoutPath, projectKey };
}

export function launchManagedProcesses(
  runtime: ResolvedProjectRuntime,
  aoRuntime: AoRuntimeHandle,
  options: LaunchSpawnOptions = {},
): LaunchProcessTree {
  const spawnImpl = options.spawnImpl ?? spawn;
  const env = buildLauncherEnv(runtime, aoRuntime, options.baseEnv);
  const ao = spawnImpl("ao", ["start"], {
    cwd: runtime.projectHome.checkoutPath as string,
    env,
    stdio: "inherit",
  });
  const bridge = spawnImpl(
    options.bunBinary ?? process.execPath,
    [
      options.bridgeScriptPath ?? resolveBridgeScriptPath(),
      "--checkout",
      runtime.projectHome.checkoutPath as string,
    ],
    {
      cwd: runtime.projectHome.checkoutPath as string,
      env,
      stdio: "inherit",
    },
  );

  let cleaned = false;
  return {
    ao,
    bridge,
    env,
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      ao.kill("SIGTERM");
      bridge.kill("SIGTERM");
      await Promise.all([
        waitForChildExit(ao),
        waitForChildExit(bridge),
      ]);
    },
  };
}

export function buildLauncherEnv(
  runtime: ResolvedProjectRuntime,
  aoRuntime: AoRuntimeHandle,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    AO_CONFIG_PATH: aoRuntime.configPath,
    ZAPBOT_PROJECT_KEY: runtime.projectHome.projectKey as string,
    ZAPBOT_CHECKOUT_PATH: runtime.projectHome.checkoutPath as string,
    ZAPBOT_MANAGED_SESSION_REGISTRY_PATH: aoRuntime.registryPath,
  };
  const webhookSecret = resolveAoWebhookSecret(runtime);
  if (webhookSecret !== null) {
    env[AO_WEBHOOK_SECRET_ENV_VAR] = webhookSecret;
  }
  for (const [key, value] of Object.entries(resolveAoWebhookSecretBindings(runtime))) {
    env[key] = value;
  }
  for (const [key, value] of Object.entries(toRuntimeEnv(runtime))) {
    env[key] = value;
  }
  return env;
}

export function resolveBridgeScriptPath(moduleUrl: string = import.meta.url): string {
  return resolve(fileURLToPath(new URL("./webhook-bridge.ts", moduleUrl)));
}

export async function reloadManagedProcesses(
  current: LaunchProcessTree,
  currentAoRuntime: AoRuntimeHandle,
  next: LoadedLaunchState,
  options: LaunchSpawnOptions = {},
): Promise<LaunchProcessTree> {
  await current.cleanup();
  await Effect.runPromise(currentAoRuntime.dispose).catch(() => undefined);
  return launchManagedProcesses(next.runtime, next.aoRuntime, options);
}

function toRuntimeEnv(runtime: ResolvedProjectRuntime): Record<string, string> {
  const firstRoute = Array.from(runtime.routes.values())[0] ?? null;
  return {
    ZAPBOT_PORT: String(runtime.bridgePort),
    ZAPBOT_AO_PORT: String(runtime.aoPort),
    ZAPBOT_API_KEY: runtime.apiKey,
    ...(runtime.gatewaySecret !== null ? { ZAPBOT_GATEWAY_SECRET: runtime.gatewaySecret } : {}),
    ...(runtime.ingress.gatewayUrl !== null ? { ZAPBOT_GATEWAY_URL: runtime.ingress.gatewayUrl } : {}),
    ...(runtime.ingress.publicUrl !== null ? { ZAPBOT_BRIDGE_URL: runtime.ingress.publicUrl } : {}),
    ...(firstRoute !== null ? { ZAPBOT_REPO: firstRoute.repo as string } : {}),
    ...buildMoltzapProcessEnv(runtime.moltzap),
  };
}

async function loadLaunchState(ref: ProjectRef): Promise<LoadedLaunchState> {
  const configService = createConfigService();
  const runtime = await Effect.runPromise(configService.loadProjectRuntime(ref));
  const aoRuntime = await Effect.runPromise(materializeAoRuntime(runtime));
  return {
    runtime,
    aoRuntime,
  };
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  const existingExitCode = child.exitCode;
  const existingSignalCode = child.signalCode;
  if (existingExitCode !== null || existingSignalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve();
    };
    child.once("exit", finish);
    child.once("close", finish);
    child.once("error", finish);
  });
}

const isMainModule =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
