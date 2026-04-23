import { Schema } from "effect";
import type { IngressPolicy } from "./ingress.ts";
import type { MoltzapRuntimeConfig } from "../moltzap/runtime.ts";
import type {
  BotUsername,
  ProjectName,
  RepoFullName,
} from "../types.ts";
import type {
  OperatorProjectHome,
  ProjectKey,
  RepoCheckoutPath,
} from "./home.ts";

export type LoggerLevel = "debug" | "info" | "warn" | "error";

export type GitHubAuthConfig =
  | { readonly _tag: "GitHubPat"; readonly token: string }
  | {
      readonly _tag: "GitHubApp";
      readonly appId: string;
      readonly installationId: string;
      readonly privateKeyPem: string;
    };

export interface RouteConfig {
  readonly projectName: ProjectName;
  readonly repo: RepoFullName;
  readonly checkoutPath: RepoCheckoutPath;
  readonly defaultBranch: string;
  readonly webhookSecret: string;
}

export interface ResolvedProjectRuntime {
  readonly projectHome: OperatorProjectHome;
  readonly bridgePort: number;
  readonly aoPort: number;
  readonly botUsername: BotUsername;
  readonly ingress: IngressPolicy;
  readonly gatewaySecret: string | null;
  readonly githubAuth: GitHubAuthConfig;
  readonly moltzap: MoltzapRuntimeConfig;
  readonly logLevel: LoggerLevel;
  readonly apiKey: string;
  readonly routes: ReadonlyMap<RepoFullName, RouteConfig>;
}

export type ConfigServiceError =
  | { readonly _tag: "ZapbotHomeMissing"; readonly path: string }
  | { readonly _tag: "ProjectHomeMissing"; readonly projectKey: ProjectKey }
  | { readonly _tag: "LegacyRepoLocalConfigUnsupported"; readonly path: string }
  | { readonly _tag: "ConfigFileUnreadable"; readonly path: string; readonly cause: string }
  | { readonly _tag: "ConfigDecodeFailed"; readonly path: string; readonly cause: string }
  | { readonly _tag: "IngressConfigInvalid"; readonly reason: string };

export const LoggerLevelSchema = Schema.Literal("debug", "info", "warn", "error");

export const GitHubPatSchema = Schema.Struct({
  mode: Schema.Literal("token"),
  token: Schema.String,
});

export const GitHubAppSchema = Schema.Struct({
  mode: Schema.Literal("app"),
  appId: Schema.String,
  installationId: Schema.String,
  privateKeyPem: Schema.String,
});

export const GitHubAuthConfigSchema = Schema.Union(GitHubPatSchema, GitHubAppSchema);

export const RouteConfigDocumentSchema = Schema.Struct({
  projectName: Schema.String,
  repo: Schema.String,
  checkoutPath: Schema.optional(Schema.String),
  defaultBranch: Schema.String,
  webhookSecret: Schema.String,
});

export const OperatorProjectConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  projectKey: Schema.String,
  checkoutPath: Schema.String,
  bridge: Schema.Struct({
    port: Schema.Number,
    aoPort: Schema.Number,
    publicUrl: Schema.NullOr(Schema.String),
    gatewayUrl: Schema.NullOr(Schema.String),
    gatewaySecret: Schema.NullOr(Schema.String),
    apiKey: Schema.String,
    botUsername: Schema.String,
    logLevel: LoggerLevelSchema,
  }),
  github: GitHubAuthConfigSchema,
  moltzap: Schema.Struct({
    serverUrl: Schema.NullOr(Schema.String),
    registrationSecret: Schema.NullOr(Schema.String),
    allowedSenders: Schema.NullOr(Schema.String),
  }),
  routes: Schema.Array(RouteConfigDocumentSchema),
});

export type OperatorProjectConfigDocument = Schema.Schema.Type<typeof OperatorProjectConfigSchema>;

export const HostedBridgeEnvSchema = Schema.Struct({
  ZAPBOT_CHECKOUT_PATH: Schema.String,
  ZAPBOT_PROJECT_KEY: Schema.optional(Schema.String),
  ZAPBOT_PORT: Schema.NumberFromString,
  ZAPBOT_AO_PORT: Schema.NumberFromString,
  ZAPBOT_BRIDGE_URL: Schema.optional(Schema.String),
  ZAPBOT_GATEWAY_URL: Schema.optional(Schema.String),
  ZAPBOT_GATEWAY_SECRET: Schema.optional(Schema.String),
  ZAPBOT_API_KEY: Schema.String,
  ZAPBOT_BOT_USERNAME: Schema.optional(Schema.String),
  ZAPBOT_LOG_LEVEL: Schema.optional(LoggerLevelSchema),
  ZAPBOT_REPO: Schema.String,
  ZAPBOT_WEBHOOK_SECRET: Schema.String,
  ZAPBOT_DEFAULT_BRANCH: Schema.optional(Schema.String),
  ZAPBOT_GITHUB_TOKEN: Schema.optional(Schema.String),
  GITHUB_APP_ID: Schema.optional(Schema.String),
  GITHUB_APP_INSTALLATION_ID: Schema.optional(Schema.String),
  GITHUB_APP_PRIVATE_KEY: Schema.optional(Schema.String),
  ZAPBOT_MOLTZAP_SERVER_URL: Schema.optional(Schema.String),
  ZAPBOT_MOLTZAP_REGISTRATION_SECRET: Schema.optional(Schema.String),
  ZAPBOT_MOLTZAP_ALLOWED_SENDERS: Schema.optional(Schema.String),
});

export type HostedBridgeEnvDocument = Schema.Schema.Type<typeof HostedBridgeEnvSchema>;
