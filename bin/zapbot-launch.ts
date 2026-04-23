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
}

interface LaunchProcessTree {
  readonly ao: ReturnType<typeof spawn>;
  readonly bridge: ReturnType<typeof spawn>;
  readonly env: NodeJS.ProcessEnv;
  readonly reload: () => void;
  readonly cleanup: () => Promise<void>;
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const configService = createConfigService();
  const ref: ProjectRef = {
    checkoutPath: asRepoCheckoutPath(args.checkoutPath),
    ...(typeof args.projectKey === "string" ? { projectKey: args.projectKey as never } : {}),
  };

  const runtime = await Effect.runPromise(configService.loadProjectRuntime(ref));
  const aoRuntime = await Effect.runPromise(materializeAoRuntime(runtime));
  const launched = launchManagedProcesses(runtime, aoRuntime);

  process.on("SIGHUP", () => {
    launched.reload();
  });
  process.on("SIGINT", () => void launched.cleanup());
  process.on("SIGTERM", () => void launched.cleanup());

  const exitCode = await waitForFirstExit(launched.ao, launched.bridge);
  await launched.cleanup();
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
  const env = buildLauncherEnv(runtime, aoRuntime);
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
    reload() {
      bridge.kill("SIGHUP");
    },
    async cleanup() {
      if (cleaned) {
        return;
      }
      cleaned = true;
      ao.kill("SIGTERM");
      bridge.kill("SIGTERM");
      await Effect.runPromise(aoRuntime.dispose).catch(() => undefined);
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
  for (const [key, value] of Object.entries(toRuntimeEnv(runtime))) {
    env[key] = value;
  }
  return env;
}

export function resolveBridgeScriptPath(moduleUrl: string = import.meta.url): string {
  return resolve(fileURLToPath(new URL("./webhook-bridge.ts", moduleUrl)));
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

async function waitForFirstExit(...children: Array<ReturnType<typeof spawn>>): Promise<number> {
  return await new Promise((resolve) => {
    for (const child of children) {
      child.once("exit", (code) => resolve(code ?? 0));
      child.once("error", () => resolve(1));
    }
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
