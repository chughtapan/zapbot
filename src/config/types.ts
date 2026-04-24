import type {
  BotUsername,
  ProjectName,
  RepoFullName,
} from "../types.ts";
import type { IngressPolicy } from "./ingress.ts";

export type ProjectConfigPath = string & { readonly __brand: "ProjectConfigPath" };
export type CanonicalConfigPath = string & { readonly __brand: "CanonicalConfigPath" };

export interface ConfigSourcePaths {
  readonly projectConfigPath: ProjectConfigPath | null;
  readonly canonicalConfigPath: CanonicalConfigPath;
}

export interface RawConfigFiles {
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
  readonly publicUrl: string | null;
  readonly gatewayUrl: string | null;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: ProjectConfigPath | null;
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly singleRepo: RepoFullName | null;
}

export interface ProjectRouteConfig {
  readonly projectName: ProjectName;
  readonly repo: RepoFullName;
  readonly defaultBranch: string;
  readonly webhookSecretEnvVar: string;
}

export interface BridgeRuntimeConfig {
  readonly port: number;
  readonly ingress: IngressPolicy;
  readonly publicUrl: string | null;
  readonly gatewayUrl: string | null;
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

export type CanonicalSecretField = "apiKey" | "webhookSecret";

export type ConfigEnvError =
  | { readonly _tag: "InvalidPort"; readonly raw: string }
  | {
      readonly _tag: "SecretCollision";
      readonly left: CanonicalSecretField;
      readonly right: CanonicalSecretField;
    };

export type ConfigDiskError =
  | { readonly _tag: "ConfigFileUnreadable"; readonly path: string; readonly cause: string }
  | { readonly _tag: "ConfigFileInvalid"; readonly path: string; readonly cause: string }
  | { readonly _tag: "CanonicalConfigMissing"; readonly path: string }
  | { readonly _tag: "CanonicalConfigInvalid"; readonly path: string; readonly cause: string }
  | { readonly _tag: "DeprecatedSecretBinding"; readonly projectName: string; readonly secretEnvVar: string };

export type ConfigLoadError = ConfigEnvError | ConfigDiskError;

export type ConfigReloadError =
  | ConfigLoadError
  | { readonly _tag: "ReloadRejected"; readonly reason: string };
