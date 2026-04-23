import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  asOperatorProjectHomePath,
  asProjectKey,
  asRepoCheckoutPath,
  defaultProjectKeyForCheckout,
  projectConfigPath,
  type ProjectKey,
} from "./home.ts";
import { OperatorProjectConfigSchema, type OperatorProjectConfigDocument } from "./schema.ts";

export interface ProjectBootstrapRequest {
  readonly checkoutPath: string;
  readonly repo: string;
  readonly projectKey?: string;
}

export interface AppendProjectRouteRequest {
  readonly checkoutPath: string;
  readonly repo: string;
  readonly projectKey?: string;
}

export interface ProjectBootstrapReceipt {
  readonly projectKey: ProjectKey;
  readonly projectHomePath: string;
  readonly configPath: string;
}

export type BootstrapConfigError =
  | { readonly _tag: "BootstrapConfigWriteFailed"; readonly cause: string }
  | { readonly _tag: "BootstrapConfigDecodeFailed"; readonly cause: string }
  | { readonly _tag: "BootstrapSecretGenerationFailed"; readonly cause: string };

export function initializeProjectConfig(
  request: ProjectBootstrapRequest,
): Effect.Effect<ProjectBootstrapReceipt, BootstrapConfigError, never> {
  return Effect.tryPromise({
    try: async () => {
      const checkoutPath = resolve(request.checkoutPath);
      const projectKey = request.projectKey
        ? asProjectKey(request.projectKey)
        : defaultProjectKeyForCheckout(asRepoCheckoutPath(checkoutPath));
      const homePath = resolveProjectHomePath(projectKey);
      const configPath = projectConfigPath(asOperatorProjectHomePath(homePath));
      await mkdir(dirname(configPath), { recursive: true });

      const document = createInitialDocument({
        checkoutPath,
        repo: request.repo,
        projectKey,
      });
      await writeProjectDocument(configPath, document);

      return {
        projectKey,
        projectHomePath: homePath,
        configPath,
      } satisfies ProjectBootstrapReceipt;
    },
    catch: (cause) => ({
      _tag: "BootstrapConfigWriteFailed",
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies BootstrapConfigError),
  });
}

export function appendProjectRoute(
  request: AppendProjectRouteRequest,
): Effect.Effect<ProjectBootstrapReceipt, BootstrapConfigError, never> {
  return Effect.tryPromise({
    try: async () => {
      const checkoutPath = resolve(request.checkoutPath);
      const projectKey = request.projectKey
        ? asProjectKey(request.projectKey)
        : defaultProjectKeyForCheckout(asRepoCheckoutPath(checkoutPath));
      const homePath = resolveProjectHomePath(projectKey);
      const configPath = projectConfigPath(asOperatorProjectHomePath(homePath));
      const raw = await readFile(configPath, "utf8");
      const parsed = Schema.decodeUnknownSync(OperatorProjectConfigSchema)(JSON.parse(raw));
      if (parsed.routes.some((route) => route.repo === request.repo)) {
        return {
          projectKey,
          projectHomePath: homePath,
          configPath,
        } satisfies ProjectBootstrapReceipt;
      }
      const next: OperatorProjectConfigDocument = {
        ...parsed,
        routes: [...parsed.routes, {
        projectName: request.repo.split("/").pop() ?? request.repo,
        repo: request.repo,
        defaultBranch: "main",
        webhookSecret: parsed.routes[0]?.webhookSecret ?? generateSecret(),
        }],
      };
      await writeProjectDocument(configPath, next);
      return {
        projectKey,
        projectHomePath: homePath,
        configPath,
      } satisfies ProjectBootstrapReceipt;
    },
    catch: (cause) => ({
      _tag: "BootstrapConfigWriteFailed",
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies BootstrapConfigError),
  });
}

export function rotateLocalSecrets(
  projectKey: ProjectKey,
): Effect.Effect<void, BootstrapConfigError, never> {
  return Effect.tryPromise({
    try: async () => {
      const configPath = projectConfigPath(asOperatorProjectHomePath(resolveProjectHomePath(projectKey)));
      const raw = await readFile(configPath, "utf8");
      const parsed = Schema.decodeUnknownSync(OperatorProjectConfigSchema)(JSON.parse(raw));
      const next: OperatorProjectConfigDocument = {
        ...parsed,
        bridge: {
          ...parsed.bridge,
          apiKey: generateSecret(),
        },
        routes: parsed.routes.map((route) => ({
          ...route,
          webhookSecret: generateSecret(),
        })),
      };
      await writeProjectDocument(configPath, next);
    },
    catch: (cause) => ({
      _tag: "BootstrapConfigWriteFailed",
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies BootstrapConfigError),
  });
}

function resolveProjectHomePath(projectKey: ProjectKey): string {
  const home = process.env.HOME;
  if (typeof home !== "string" || home.trim().length === 0) {
    throw new Error("HOME must be set to initialize canonical ~/.zapbot project config");
  }
  return join(home, ".zapbot", "projects", projectKey as string);
}

function createInitialDocument(input: {
  readonly checkoutPath: string;
  readonly repo: string;
  readonly projectKey: ProjectKey;
}): OperatorProjectConfigDocument {
  const webhookSecret = generateSecret();
  return {
    version: 1,
    projectKey: input.projectKey as string,
    checkoutPath: input.checkoutPath,
    bridge: {
      port: 3000,
      aoPort: 3001,
      publicUrl: null,
      gatewayUrl: null,
      gatewaySecret: null,
      apiKey: generateSecret(),
      botUsername: "zapbot[bot]",
      logLevel: "info",
    },
    github: {
      mode: "token",
      token: "",
    },
    moltzap: {
      serverUrl: null,
      registrationSecret: null,
      allowedSenders: null,
    },
    routes: [{
      projectName: input.repo.split("/").pop() ?? input.repo,
      repo: input.repo,
      defaultBranch: "main",
      webhookSecret,
    }],
  };
}

async function writeProjectDocument(
  path: string,
  document: OperatorProjectConfigDocument,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}

function generateSecret(): string {
  return randomBytes(32).toString("hex");
}
