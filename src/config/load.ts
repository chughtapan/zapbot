import { join } from "path";
import {
  asProjectName,
  ok,
  type Result,
} from "../types.ts";
import type {
  BridgeRuntimeConfig,
  CanonicalConfigPath,
  ConfigLoadError,
  ConfigSourcePaths,
  NormalizedRuntimeEnv,
  ProjectConfigDocument,
  ProjectConfigPath,
  ProjectRouteConfig,
} from "./types.ts";
import type { IngressPolicy } from "./ingress.ts";
import type { RepoFullName } from "../types.ts";

function resolveCanonicalConfigPath(
  env: Record<string, string | undefined>,
): CanonicalConfigPath {
  const override = env.ZAPBOT_CONFIG_JSON?.trim();
  if (override !== undefined && override.length > 0) {
    return override as CanonicalConfigPath;
  }
  const home = env.HOME ?? "";
  return join(home, ".zapbot", "config.json") as CanonicalConfigPath;
}

export function deriveConfigSourcePaths(
  configPath: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ConfigSourcePaths {
  const projectConfigPath =
    configPath === undefined || configPath.length === 0
      ? null
      : (configPath as ProjectConfigPath);

  return {
    projectConfigPath,
    canonicalConfigPath: resolveCanonicalConfigPath(env),
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
  document: ProjectConfigDocument | null,
  ingress: IngressPolicy,
): Result<BridgeRuntimeConfig, ConfigLoadError> {
  const routeResult = buildRepoRoutes(document);
  if (routeResult._tag === "Err") return routeResult;

  const routes = routeResult.value.size > 0
    ? routeResult.value
    : buildSingleRepoFallback(env);

  return ok({
    port: env.port,
    ingress,
    publicUrl: ingress.publicUrl,
    gatewayUrl: ingress.gatewayUrl,
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

