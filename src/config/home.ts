import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Effect } from "effect";
import type { ConfigServiceError } from "./schema.ts";

export type ProjectKey = string & { readonly __brand: "ProjectKey" };
export type RepoCheckoutPath = string & { readonly __brand: "RepoCheckoutPath" };
export type ZapbotHomePath = string & { readonly __brand: "ZapbotHomePath" };
export type OperatorProjectHomePath = string & { readonly __brand: "OperatorProjectHomePath" };

export interface ProjectRef {
  readonly checkoutPath: RepoCheckoutPath;
  readonly projectKey?: ProjectKey;
}

export interface OperatorProjectHome {
  readonly projectKey: ProjectKey;
  readonly homePath: OperatorProjectHomePath;
  readonly checkoutPath: RepoCheckoutPath;
}

interface ProjectHomeIndexRecord {
  readonly projectKey?: unknown;
  readonly checkoutPath?: unknown;
  readonly routes?: unknown;
}

const PROJECTS_DIR = "projects";
const PROJECT_CONFIG_FILE = "project.json";
const PROJECT_STATE_DIR = "state";

export function asProjectKey(value: string): ProjectKey {
  return value as ProjectKey;
}

export function asRepoCheckoutPath(value: string): RepoCheckoutPath {
  return value as RepoCheckoutPath;
}

export function asZapbotHomePath(value: string): ZapbotHomePath {
  return value as ZapbotHomePath;
}

export function asOperatorProjectHomePath(value: string): OperatorProjectHomePath {
  return value as OperatorProjectHomePath;
}

export function slugifyProjectKey(value: string): ProjectKey {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  const fallback = normalized.length > 0 ? normalized : "project";
  return asProjectKey(fallback);
}

export function defaultProjectKeyForCheckout(checkoutPath: RepoCheckoutPath): ProjectKey {
  return slugifyProjectKey(basename(checkoutPath as string));
}

export function projectConfigPath(home: OperatorProjectHome | OperatorProjectHomePath): string {
  return join(typeof home === "string" ? home : (home.homePath as string), PROJECT_CONFIG_FILE);
}

export function projectStateDir(home: OperatorProjectHome | OperatorProjectHomePath): string {
  return join(typeof home === "string" ? home : (home.homePath as string), PROJECT_STATE_DIR);
}

export function resolveZapbotHome(): Effect.Effect<ZapbotHomePath, ConfigServiceError, never> {
  return Effect.try({
    try: () => {
    const home = process.env.HOME;
    if (typeof home !== "string" || home.trim().length === 0) {
      throw new Error("HOME must be set for canonical ~/.zapbot config");
    }
    return asZapbotHomePath(join(home, ".zapbot"));
    },
    catch: () => ({
        _tag: "ZapbotHomeMissing",
        path: "~/.zapbot",
      } satisfies ConfigServiceError),
  });
}

export function resolveProjectHome(ref: ProjectRef): Effect.Effect<OperatorProjectHome, ConfigServiceError, never> {
  return Effect.gen(function* () {
    const checkoutPath = normalizeCheckoutPath(ref.checkoutPath);
    const root = yield* resolveZapbotHome();
    if (!existsSync(root as string)) {
      return yield* Effect.fail<ConfigServiceError>({
        _tag: "ZapbotHomeMissing",
        path: root as string,
      });
    }

    if (ref.projectKey !== undefined) {
      const homePath = asOperatorProjectHomePath(join(root as string, PROJECTS_DIR, ref.projectKey as string));
      if (!existsSync(projectConfigPath(homePath))) {
        return yield* Effect.fail<ConfigServiceError>({
          _tag: "ProjectHomeMissing",
          projectKey: ref.projectKey,
        });
      }
      return {
        projectKey: ref.projectKey,
        homePath,
        checkoutPath,
      } satisfies OperatorProjectHome;
    }

    const projectsRoot = join(root as string, PROJECTS_DIR);
    if (!existsSync(projectsRoot)) {
      return yield* Effect.fail<ConfigServiceError>({
        _tag: "ProjectHomeMissing",
        projectKey: defaultProjectKeyForCheckout(checkoutPath),
      });
    }

    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const homePath = asOperatorProjectHomePath(join(projectsRoot, entry.name));
      const configPath = projectConfigPath(homePath);
      if (!existsSync(configPath)) {
        continue;
      }
      const record = readProjectHomeIndexRecord(configPath);
      if (record === null) {
        continue;
      }
      if (record.checkoutPaths.some((candidate) => normalizeAbsolutePath(candidate) === checkoutPath)) {
        return {
          projectKey: asProjectKey(record.projectKey),
          homePath,
          checkoutPath,
        } satisfies OperatorProjectHome;
      }
    }

    return yield* Effect.fail<ConfigServiceError>({
      _tag: "ProjectHomeMissing",
      projectKey: defaultProjectKeyForCheckout(checkoutPath),
    });
  });
}

function normalizeCheckoutPath(path: RepoCheckoutPath): RepoCheckoutPath {
  return asRepoCheckoutPath(normalizeAbsolutePath(path as string));
}

function normalizeAbsolutePath(path: string): string {
  return resolve(path);
}

function readProjectHomeIndexRecord(
  configPath: string,
): { readonly projectKey: string; readonly checkoutPaths: ReadonlyArray<string> } | null {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as ProjectHomeIndexRecord;
    if (typeof parsed.projectKey !== "string" || typeof parsed.checkoutPath !== "string") {
      return null;
    }
    const routeCheckoutPaths = Array.isArray(parsed.routes)
      ? parsed.routes.flatMap((route) => {
        if (!route || typeof route !== "object") {
          return [];
        }
        const checkoutPath = (route as { readonly checkoutPath?: unknown }).checkoutPath;
        return typeof checkoutPath === "string" ? [checkoutPath] : [];
      })
      : [];
    return {
      projectKey: parsed.projectKey,
      checkoutPaths: [parsed.checkoutPath, ...routeCheckoutPaths],
    };
  } catch {
    return null;
  }
}
