import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  asProjectKey,
  asRepoCheckoutPath,
  defaultProjectKeyForCheckout,
  projectConfigPath,
  resolveProjectHome,
  resolveZapbotHome,
  type ProjectRef,
} from "./home.ts";
import {
  HostedBridgeEnvSchema,
  OperatorProjectConfigSchema,
  type ConfigServiceError,
  type GitHubAuthConfig,
  type HostedBridgeEnvDocument,
  type LoggerLevel,
  type OperatorProjectConfigDocument,
  type ResolvedProjectRuntime,
  type RouteConfig,
} from "./schema.ts";
import { resolveIngressPolicy } from "./ingress.ts";
import { loadMoltzapRuntimeConfig } from "../moltzap/runtime.ts";
import {
  asBotUsername,
  asProjectName,
  asRepoFullName,
  type RepoFullName,
} from "../types.ts";

export interface ConfigService {
  readonly loadProjectRuntime: (
    ref: ProjectRef,
  ) => Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never>;
  readonly loadBridgeRuntime: (
    ref: ProjectRef,
  ) => Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never>;
  readonly reloadBridgeRuntime: (
    ref: ProjectRef,
    currentVersion: string,
  ) => Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never>;
  readonly loadHostedBridgeRuntime: () => Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never>;
  readonly loadSessionRuntime: (
    ref: ProjectRef,
  ) => Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never>;
}

export function createConfigService(): ConfigService {
  return {
    loadProjectRuntime,
    loadBridgeRuntime,
    reloadBridgeRuntime: (ref) => loadProjectRuntime(ref),
    loadHostedBridgeRuntime,
    loadSessionRuntime: loadProjectRuntime,
  };
}

export function loadProjectRuntime(
  ref: ProjectRef,
): Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never> {
  return Effect.gen(function* () {
    yield* rejectLegacyCheckoutArtifacts(ref.checkoutPath);
    const projectHome = yield* resolveProjectHome(ref);
    const configPath = projectConfigPath(projectHome);
    const raw = yield* readTextFile(configPath);
    const document = yield* decodeProjectConfig(configPath, raw);
    const ingress = yield* deriveIngress(document.bridge.gatewayUrl, document.bridge.publicUrl);
    const moltzap = yield* decodeMoltzap(document);

    return {
      projectHome,
      bridgePort: document.bridge.port,
      aoPort: document.bridge.aoPort,
      botUsername: asBotUsername(document.bridge.botUsername),
      ingress,
      gatewaySecret: document.bridge.gatewaySecret,
      githubAuth: toGitHubAuth(document.github),
      moltzap,
      logLevel: document.bridge.logLevel,
      apiKey: document.bridge.apiKey,
      routes: buildRoutes(document),
    } satisfies ResolvedProjectRuntime;
  });
}

export function loadBridgeRuntime(
  ref: ProjectRef,
): Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never> {
  return loadProjectRuntime(ref);
}

export function loadHostedBridgeRuntime(): Effect.Effect<ResolvedProjectRuntime, ConfigServiceError, never> {
  return Effect.gen(function* () {
    const env = yield* loadHostedEnv();
    const checkoutPath = asRepoCheckoutPath(env.ZAPBOT_CHECKOUT_PATH);
    const zapbotHome = yield* resolveZapbotHome();
    const projectKey = asProjectKey(env.ZAPBOT_PROJECT_KEY ?? defaultProjectKeyForCheckout(checkoutPath));
    const projectHome = {
      projectKey,
      homePath: join(zapbotHome as string, "projects", projectKey as string) as never,
      checkoutPath,
    };
    const ingress = yield* deriveIngress(
      env.ZAPBOT_GATEWAY_URL ?? null,
      env.ZAPBOT_BRIDGE_URL ?? null,
    );
    const moltzap = yield* decodeHostedMoltzap(env);
    const githubAuth = yield* decodeHostedGitHubAuth(env);

    return {
      projectHome,
      bridgePort: env.ZAPBOT_PORT,
      aoPort: env.ZAPBOT_AO_PORT,
      botUsername: asBotUsername(env.ZAPBOT_BOT_USERNAME ?? "zapbot[bot]"),
      ingress,
      gatewaySecret: env.ZAPBOT_GATEWAY_SECRET ?? null,
      githubAuth,
      moltzap,
      logLevel: (env.ZAPBOT_LOG_LEVEL ?? "info") as LoggerLevel,
      apiKey: env.ZAPBOT_API_KEY,
      routes: new Map([
        [asRepoFullName(env.ZAPBOT_REPO), {
          projectName: asProjectName(env.ZAPBOT_REPO.split("/").pop() ?? env.ZAPBOT_REPO),
          repo: asRepoFullName(env.ZAPBOT_REPO),
          checkoutPath,
          defaultBranch: env.ZAPBOT_DEFAULT_BRANCH ?? "main",
          webhookSecret: env.ZAPBOT_WEBHOOK_SECRET,
        }],
      ]),
    } satisfies ResolvedProjectRuntime;
  });
}

function rejectLegacyCheckoutArtifacts(checkoutPath: string): Effect.Effect<void, ConfigServiceError, never> {
  return Effect.gen(function* () {
    for (const relative of [".env", "agent-orchestrator.yaml"]) {
      const candidate = `${checkoutPath}/${relative}`;
      if (existsSync(candidate)) {
        return yield* Effect.fail<ConfigServiceError>({
          _tag: "LegacyRepoLocalConfigUnsupported",
          path: candidate,
        });
      }
    }
  });
}

function readTextFile(path: string): Effect.Effect<string, ConfigServiceError, never> {
  return Effect.try({
    try: () => readFileSync(path, "utf8"),
    catch: (cause) => ({
      _tag: "ConfigFileUnreadable",
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies ConfigServiceError),
  });
}

function decodeProjectConfig(
  path: string,
  raw: string,
): Effect.Effect<OperatorProjectConfigDocument, ConfigServiceError, never> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(OperatorProjectConfigSchema)(JSON.parse(raw)),
    catch: (cause) => ({
      _tag: "ConfigDecodeFailed",
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies ConfigServiceError),
  });
}

function deriveIngress(
  gatewayUrl: string | null,
  publicUrl: string | null,
): Effect.Effect<ResolvedProjectRuntime["ingress"], ConfigServiceError, never> {
  return Effect.tryPromise({
    try: async () => {
      const result = await resolveIngressPolicy({
        mode: gatewayUrl === null ? "local-only" : "github-demo",
        gatewayUrl: gatewayUrl ?? "",
        publicUrl,
        isPublicUrlReachable: async (url) => {
          try {
            const response = await fetch(`${url.replace(/\/+$/u, "")}/healthz`, {
              signal: AbortSignal.timeout(2_000),
            });
            return response.ok;
          } catch {
            return false;
          }
        },
      });
      if (result._tag === "Err") {
        throw result.error;
      }
      return result.value;
    },
    catch: (cause) => ({
      _tag: "IngressConfigInvalid",
      reason: formatIngressFailure(cause),
    } satisfies ConfigServiceError),
  });
}

function decodeMoltzap(
  document: OperatorProjectConfigDocument,
): Effect.Effect<ResolvedProjectRuntime["moltzap"], ConfigServiceError, never> {
  const decoded = loadMoltzapRuntimeConfig({
    ZAPBOT_MOLTZAP_SERVER_URL: document.moltzap.serverUrl ?? undefined,
    ZAPBOT_MOLTZAP_REGISTRATION_SECRET: document.moltzap.registrationSecret ?? undefined,
    ZAPBOT_MOLTZAP_ALLOWED_SENDERS: document.moltzap.allowedSenders ?? undefined,
  });
  if (decoded._tag === "Err") {
    return Effect.fail({
      _tag: "ConfigDecodeFailed",
      path: "moltzap",
      cause: decoded.error.reason,
    } satisfies ConfigServiceError);
  }
  return Effect.succeed(decoded.value);
}

function decodeHostedMoltzap(
  env: HostedBridgeEnvDocument,
): Effect.Effect<ResolvedProjectRuntime["moltzap"], ConfigServiceError, never> {
  const decoded = loadMoltzapRuntimeConfig({
    ZAPBOT_MOLTZAP_SERVER_URL: env.ZAPBOT_MOLTZAP_SERVER_URL,
    ZAPBOT_MOLTZAP_REGISTRATION_SECRET: env.ZAPBOT_MOLTZAP_REGISTRATION_SECRET,
    ZAPBOT_MOLTZAP_ALLOWED_SENDERS: env.ZAPBOT_MOLTZAP_ALLOWED_SENDERS,
  });
  if (decoded._tag === "Err") {
    return Effect.fail({
      _tag: "ConfigDecodeFailed",
      path: "hosted-env:moltzap",
      cause: decoded.error.reason,
    } satisfies ConfigServiceError);
  }
  return Effect.succeed(decoded.value);
}

function buildRoutes(document: OperatorProjectConfigDocument): ReadonlyMap<RepoFullName, RouteConfig> {
  return new Map(
    document.routes.map((route) => [
      asRepoFullName(route.repo),
      {
        projectName: asProjectName(route.projectName),
        repo: asRepoFullName(route.repo),
        checkoutPath: asRepoCheckoutPath(route.checkoutPath),
        defaultBranch: route.defaultBranch,
        webhookSecret: route.webhookSecret,
      } satisfies RouteConfig,
    ]),
  );
}

function toGitHubAuth(document: OperatorProjectConfigDocument["github"]): GitHubAuthConfig {
  if (document.mode === "token") {
    return {
      _tag: "GitHubPat",
      token: document.token,
    };
  }
  return {
    _tag: "GitHubApp",
    appId: document.appId,
    installationId: document.installationId,
    privateKeyPem: document.privateKeyPem,
  };
}

function decodeHostedGitHubAuth(
  env: HostedBridgeEnvDocument,
): Effect.Effect<GitHubAuthConfig, ConfigServiceError, never> {
  if (typeof env.ZAPBOT_GITHUB_TOKEN === "string" && env.ZAPBOT_GITHUB_TOKEN.trim().length > 0) {
    return Effect.succeed({
      _tag: "GitHubPat",
      token: env.ZAPBOT_GITHUB_TOKEN,
    });
  }
  if (
    typeof env.GITHUB_APP_ID === "string" &&
    typeof env.GITHUB_APP_INSTALLATION_ID === "string" &&
    typeof env.GITHUB_APP_PRIVATE_KEY === "string"
  ) {
    return Effect.succeed({
      _tag: "GitHubApp",
      appId: env.GITHUB_APP_ID,
      installationId: env.GITHUB_APP_INSTALLATION_ID,
      privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
    });
  }
  return Effect.fail({
    _tag: "ConfigDecodeFailed",
    path: "hosted-env:github",
    cause: "Set either ZAPBOT_GITHUB_TOKEN or the GitHub App env triplet.",
  } satisfies ConfigServiceError);
}

function loadHostedEnv(): Effect.Effect<HostedBridgeEnvDocument, ConfigServiceError, never> {
  return Effect.try({
    try: () => {
      return Schema.decodeUnknownSync(HostedBridgeEnvSchema)({
        ZAPBOT_CHECKOUT_PATH: process.env.ZAPBOT_CHECKOUT_PATH,
        ZAPBOT_PROJECT_KEY: process.env.ZAPBOT_PROJECT_KEY,
        ZAPBOT_PORT: process.env.ZAPBOT_PORT ?? "3000",
        ZAPBOT_AO_PORT: process.env.ZAPBOT_AO_PORT ?? "3001",
        ZAPBOT_BRIDGE_URL: process.env.ZAPBOT_BRIDGE_URL,
        ZAPBOT_GATEWAY_URL: process.env.ZAPBOT_GATEWAY_URL,
        ZAPBOT_GATEWAY_SECRET: process.env.ZAPBOT_GATEWAY_SECRET,
        ZAPBOT_API_KEY: process.env.ZAPBOT_API_KEY,
        ZAPBOT_BOT_USERNAME: process.env.ZAPBOT_BOT_USERNAME,
        ZAPBOT_LOG_LEVEL: process.env.ZAPBOT_LOG_LEVEL,
        ZAPBOT_REPO: process.env.ZAPBOT_REPO,
        ZAPBOT_WEBHOOK_SECRET: process.env.ZAPBOT_WEBHOOK_SECRET,
        ZAPBOT_DEFAULT_BRANCH: process.env.ZAPBOT_DEFAULT_BRANCH,
        ZAPBOT_GITHUB_TOKEN: process.env.ZAPBOT_GITHUB_TOKEN,
        GITHUB_APP_ID: process.env.GITHUB_APP_ID,
        GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
        GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY,
        ZAPBOT_MOLTZAP_SERVER_URL: process.env.ZAPBOT_MOLTZAP_SERVER_URL,
        ZAPBOT_MOLTZAP_REGISTRATION_SECRET: process.env.ZAPBOT_MOLTZAP_REGISTRATION_SECRET,
        ZAPBOT_MOLTZAP_ALLOWED_SENDERS: process.env.ZAPBOT_MOLTZAP_ALLOWED_SENDERS,
      });
    },
    catch: (cause) => ({
      _tag: "ConfigDecodeFailed",
      path: "process.env",
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies ConfigServiceError),
  });
}

function formatIngressFailure(cause: unknown): string {
  if (cause && typeof cause === "object" && "_tag" in cause) {
    const tagged = cause as { readonly _tag?: string; readonly publicUrl?: string; readonly mode?: string };
    switch (tagged._tag) {
      case "MissingPublicBridgeUrl":
        return "ZAPBOT_BRIDGE_URL is required in GitHub demo mode.";
      case "UnreachablePublicBridgeUrl":
        return `ZAPBOT_BRIDGE_URL is unreachable: ${tagged.publicUrl ?? ""}`;
      case "DemoModeRequiresGateway":
        return "ZAPBOT_GATEWAY_URL is required in GitHub demo mode.";
      case "InvalidIngressMode":
        return `Unsupported ingress mode: ${tagged.mode ?? ""}`;
      default:
        break;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}
