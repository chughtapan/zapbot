import type {
  BotUsername,
  ProjectName,
  RepoFullName,
} from "../types.ts";

export type EnvFilePath = string & { readonly __brand: "EnvFilePath" };
export type ProjectConfigPath = string & { readonly __brand: "ProjectConfigPath" };

export interface ConfigSourcePaths {
  readonly envFilePath: EnvFilePath | null;
  readonly projectConfigPath: ProjectConfigPath | null;
}

export interface ParsedEnvFile {
  readonly values: Readonly<Record<string, string>>;
}

export interface RawConfigFiles {
  readonly envFileText: string | null;
  readonly projectConfigText: string | null;
}

export interface ProjectRouteDocument {
  readonly repo: RepoFullName;
  readonly path: string;
  readonly defaultBranch: string;
  readonly webhookSecretEnvVar: string;
}

export interface ProjectConfigDocument {
  readonly projects: ReadonlyMap<ProjectName, ProjectRouteDocument>;
}

export interface NormalizedRuntimeEnv {
  readonly port: number;
  readonly publicUrl: string;
  readonly gatewayUrl: string;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: ProjectConfigPath | null;
  readonly apiKey: string;
  readonly webhookSecret: string;
}

export interface ProjectRouteConfig {
  readonly projectName: ProjectName;
  readonly repo: RepoFullName;
  readonly defaultBranch: string;
  readonly webhookSecretEnvVar: string;
}

export interface BridgeRuntimeConfig {
  readonly port: number;
  readonly publicUrl: string;
  readonly gatewayUrl: string;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: ProjectConfigPath | null;
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly routes: ReadonlyMap<RepoFullName, ProjectRouteConfig>;
}

export interface ReloadedRuntimeConfig {
  readonly next: BridgeRuntimeConfig;
  readonly secretRotated: boolean;
}

export type ConfigEnvError =
  | { readonly _tag: "MalformedEnvLine"; readonly line: string }
  | { readonly _tag: "MissingRequiredEnv"; readonly key: string }
  | { readonly _tag: "InvalidPort"; readonly raw: string }
  | { readonly _tag: "SecretCollision"; readonly left: string; readonly right: string };

export type ConfigDiskError =
  | { readonly _tag: "ConfigFileUnreadable"; readonly path: string; readonly cause: string }
  | { readonly _tag: "ConfigFileInvalid"; readonly path: string; readonly cause: string }
  | { readonly _tag: "DeprecatedSecretBinding"; readonly projectName: string; readonly secretEnvVar: string };

export type ConfigLoadError = ConfigEnvError | ConfigDiskError;

export type ConfigReloadError =
  | ConfigLoadError
  | { readonly _tag: "ReloadRejected"; readonly reason: string };
