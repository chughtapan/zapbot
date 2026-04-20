import { type Result } from "../types.ts";
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
  throw new Error("not implemented");
}

export function buildRepoRoutes(
  document: ProjectConfigDocument | null,
): Result<ReadonlyMap<RepoFullName, ProjectRouteConfig>, ConfigLoadError> {
  throw new Error("not implemented");
}

export function loadBridgeRuntimeConfig(
  env: NormalizedRuntimeEnv,
  parsedEnvFile: ParsedEnvFile | null,
  document: ProjectConfigDocument | null,
): Result<BridgeRuntimeConfig, ConfigLoadError> {
  throw new Error("not implemented");
}
