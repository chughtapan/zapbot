import { dirname, join } from "path";
import {
  asProjectName,
  asRepoFullName,
  err,
  ok,
  type Result,
} from "../types.ts";
import type {
  BridgeRuntimeConfig,
  ConfigLoadError,
  ConfigSourcePaths,
  NormalizedRuntimeEnv,
  ParsedEnvFile,
  ProjectConfigDocument,
  ProjectRouteConfig,
} from "./types.ts";
import type { RepoFullName } from "../types.ts";

export function deriveConfigSourcePaths(
  configPath: string | undefined,
): ConfigSourcePaths {
  if (!configPath) {
    return {
      envFilePath: null,
      projectConfigPath: null,
    };
  }

  const envFilePath = configPath.endsWith("agent-orchestrator.yaml")
    ? configPath.replace(/agent-orchestrator\.yaml$/u, ".env")
    : join(dirname(configPath), ".env");

  return {
    envFilePath: envFilePath as ConfigSourcePaths["envFilePath"],
    projectConfigPath: configPath as ConfigSourcePaths["projectConfigPath"],
  };
}

export function buildRepoRoutes(
  document: ProjectConfigDocument | null,
): Result<ReadonlyMap<RepoFullName, ProjectRouteConfig>, ConfigLoadError> {
  if (document === null) {
    return ok(new Map());
  }

  const routes = new Map<RepoFullName, ProjectRouteConfig>();
  for (const [projectName, project] of document.projects) {
    routes.set(project.repo, {
      projectName,
      repo: project.repo,
      defaultBranch: project.defaultBranch,
      webhookSecretEnvVar: project.webhookSecretEnvVar,
    });
  }

  return ok(routes);
}

export function loadBridgeRuntimeConfig(
  env: NormalizedRuntimeEnv,
  _parsedEnvFile: ParsedEnvFile | null,
  document: ProjectConfigDocument | null,
): Result<BridgeRuntimeConfig, ConfigLoadError> {
  const routeResult = buildRepoRoutes(document);
  if (routeResult._tag === "Err") return routeResult;

  const routes = routeResult.value.size > 0
    ? routeResult.value
    : buildSingleRepoFallback(env);

  return ok({
    port: env.port,
    publicUrl: env.publicUrl,
    gatewayUrl: env.gatewayUrl,
    gatewaySecret: env.gatewaySecret,
    botUsername: env.botUsername,
    aoConfigPath: env.aoConfigPath,
    apiKey: env.apiKey,
    webhookSecret: env.webhookSecret,
    routes,
  });
}

function buildSingleRepoFallback(
  env: NormalizedRuntimeEnv,
): ReadonlyMap<RepoFullName, ProjectRouteConfig> {
  if (env.singleRepo === null) {
    return new Map();
  }

  const projectName = asProjectName(
    (env.singleRepo as unknown as string).split("/").pop() ?? (env.singleRepo as unknown as string),
  );

  return new Map([
    [env.singleRepo, {
      projectName,
      repo: env.singleRepo,
      defaultBranch: "main",
      webhookSecretEnvVar: "ZAPBOT_WEBHOOK_SECRET",
    }],
  ]);
}
