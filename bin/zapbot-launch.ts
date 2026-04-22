#!/usr/bin/env bun

import { spawn } from "node:child_process";
import process from "node:process";
import { Effect } from "effect";
import { materializeAoRuntime } from "../src/config/ao-runtime.ts";
import { asRepoCheckoutPath, type ProjectRef } from "../src/config/home.ts";
import { createConfigService } from "../src/config/service.ts";
import type { ResolvedProjectRuntime } from "../src/config/schema.ts";
import { buildMoltzapProcessEnv } from "../src/moltzap/runtime.ts";

interface LaunchArgs {
  readonly checkoutPath: string;
  readonly projectKey?: string;
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

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AO_CONFIG_PATH: aoRuntime.configPath,
    ZAPBOT_PROJECT_KEY: runtime.projectHome.projectKey as string,
    ZAPBOT_CHECKOUT_PATH: runtime.projectHome.checkoutPath as string,
    ZAPBOT_MANAGED_SESSION_REGISTRY_PATH: aoRuntime.registryPath,
  };
  for (const [key, value] of Object.entries(toRuntimeEnv(runtime))) {
    env[key] = value;
  }

  const ao = spawn("ao", ["start"], {
    cwd: runtime.projectHome.checkoutPath as string,
    env,
    stdio: "inherit",
  });
  const bridge = spawn("bun", ["bin/webhook-bridge.ts", "--checkout", runtime.projectHome.checkoutPath as string], {
    cwd: runtime.projectHome.checkoutPath as string,
    env,
    stdio: "inherit",
  });

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    ao.kill("SIGTERM");
    bridge.kill("SIGTERM");
    await Effect.runPromise(aoRuntime.dispose).catch(() => undefined);
  };

  process.on("SIGINT", () => void cleanup());
  process.on("SIGTERM", () => void cleanup());

  const exitCode = await waitForFirstExit(ao, bridge);
  await cleanup();
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

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
