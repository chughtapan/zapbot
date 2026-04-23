#!/usr/bin/env bun

import process from "node:process";
import { Effect } from "effect";
import { materializeAoRuntime } from "../src/config/ao-runtime.ts";
import { asProjectKey, asRepoCheckoutPath, type ProjectRef } from "../src/config/home.ts";
import { createConfigService } from "../src/config/service.ts";
import { buildMoltzapProcessEnv } from "../src/moltzap/runtime.ts";
import { startBridge, type BridgeConfig, type BridgeDependencies, type RepoRoute } from "../src/bridge.ts";
import { createAoCliControlHost } from "../src/orchestrator/runtime.ts";
import { createRuntimeServices } from "../src/runtime/services.ts";
import { asRepoFullName } from "../src/types.ts";

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const configService = createConfigService();
  const ref: ProjectRef = {
    checkoutPath: asRepoCheckoutPath(args.checkoutPath),
    ...(typeof args.projectKey === "string" ? { projectKey: asProjectKey(args.projectKey) } : {}),
  };

  let loaded = await loadBridgeRuntime(ref, args.hosted);
  const running = await startBridge(loaded.config, loaded.dependencies);

  const shutdown = async () => {
    await running.stop();
    if (loaded.disposeAo !== null) {
      await Effect.runPromise(loaded.disposeAo).catch(() => undefined);
    }
  };

  process.on("SIGHUP", () => {
    void (async () => {
      let nextLoaded: Awaited<ReturnType<typeof loadBridgeRuntime>> | null = null;
      try {
        nextLoaded = await loadBridgeRuntime(ref, args.hosted);
        await running.reload(nextLoaded.config, nextLoaded.dependencies);
        if (loaded.disposeAo !== null) {
          await Effect.runPromise(loaded.disposeAo).catch(() => undefined);
        }
        loaded = nextLoaded;
      } catch (error) {
        if (nextLoaded !== null && nextLoaded.disposeAo !== null) {
          await Effect.runPromise(nextLoaded.disposeAo).catch(() => undefined);
        }
        console.error(error instanceof Error ? error.message : String(error));
        await shutdown().catch(() => undefined);
        process.exit(1);
      }
    })();
  });

  process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

async function loadBridgeRuntime(
  ref: ProjectRef,
  hosted: boolean,
): Promise<{
  readonly config: BridgeConfig;
  readonly dependencies: BridgeDependencies;
  readonly disposeAo: Effect.Effect<void, unknown, never> | null;
}> {
  const configService = createConfigService();
  const runtime = await Effect.runPromise(
    hosted ? configService.loadHostedBridgeRuntime() : configService.loadBridgeRuntime(ref),
  );
  const services = await Effect.runPromise(createRuntimeServices(runtime));

  const explicitAoConfigPath = normalizeEnv(process.env.AO_CONFIG_PATH);
  const explicitRegistryPath = normalizeEnv(process.env.ZAPBOT_MANAGED_SESSION_REGISTRY_PATH);
  const aoRuntime = explicitAoConfigPath && explicitRegistryPath
    ? {
        configPath: explicitAoConfigPath,
        registryPath: explicitRegistryPath,
        dispose: null,
      }
    : await Effect.runPromise(materializeAoRuntime(runtime).pipe(Effect.map((value) => ({ ...value, dispose: value.dispose }))));

  const config: BridgeConfig = {
    port: runtime.bridgePort,
    ingress: runtime.ingress,
    publicUrl: runtime.ingress.publicUrl,
    gatewayUrl: runtime.ingress.gatewayUrl,
    gatewaySecret: runtime.gatewaySecret,
    botUsername: runtime.botUsername,
    aoConfigPath: aoRuntime.configPath,
    apiKey: runtime.apiKey,
    moltzap: runtime.moltzap,
    repos: new Map(
      Array.from(runtime.routes.entries()).map(([repo, route]) => [
        asRepoFullName(repo as string),
        {
          projectName: route.projectName,
          webhookSecret: route.webhookSecret,
          defaultBranch: route.defaultBranch,
        } satisfies RepoRoute,
      ]),
    ),
  };

  const dependencies: BridgeDependencies = {
    loggerFactory: services.loggerFactory,
    githubClient: services.githubClient,
    githubState: services.githubState,
    mintToken: services.mintInstallationToken,
    createAoControlHost(current) {
      return createAoCliControlHost({
        configPath: aoRuntime.configPath,
        registryPath: aoRuntime.registryPath,
        env: {
          ...process.env,
          ...buildMoltzapProcessEnv(current.moltzap),
        },
      });
    },
    gatewayHeartbeatMs: parseInt(normalizeEnv(process.env.ZAPBOT_GATEWAY_HEARTBEAT_MS) ?? "300000", 10),
  };

  return {
    config,
    dependencies,
    disposeAo: "dispose" in aoRuntime && aoRuntime.dispose !== null ? aoRuntime.dispose : null,
  };
}

function parseArgs(argv: readonly string[]): { readonly checkoutPath: string; readonly projectKey?: string; readonly hosted: boolean } {
  let checkoutPath = process.cwd();
  let projectKey: string | undefined;
  let hosted = false;

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
    if (arg === "--hosted") {
      hosted = true;
      continue;
    }
  }

  return { checkoutPath, projectKey, hosted };
}

function normalizeEnv(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
