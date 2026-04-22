import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { stringify as stringifyYaml } from "yaml";
import { projectStateDir, type RepoCheckoutPath } from "./home.ts";
import type { ResolvedProjectRuntime } from "./schema.ts";
import { resolveManagedSessionRegistryPath } from "../lifecycle/contracts.ts";
import type { ProjectName, RepoFullName } from "../types.ts";

export interface AoRuntimeHandle {
  readonly configPath: string;
  readonly registryPath: string;
  readonly dispose: Effect.Effect<void, AoRuntimeDisposeError, never>;
}

export type AoRuntimeMaterializationError =
  | { readonly _tag: "AoConfigMaterializationFailed"; readonly cause: string }
  | { readonly _tag: "ManagedRegistryPathInvalid"; readonly path: string };

export type AoRuntimeDisposeError = {
  readonly _tag: "AoRuntimeDisposeFailed";
  readonly cause: string;
};

export function materializeAoRuntime(
  runtime: ResolvedProjectRuntime,
): Effect.Effect<AoRuntimeHandle, AoRuntimeMaterializationError, never> {
  return Effect.tryPromise({
    try: async () => {
      const tempDir = await mkdtemp(join(tmpdir(), "zapbot-ao-runtime-"));
      const configPath = join(tempDir, "agent-orchestrator.generated.yaml");
      const yamlText = buildAoRuntimeYaml(runtime);
      await writeFile(configPath, yamlText, "utf8");
      const registryPath = resolveManagedSessionRegistryPath({
        projectHomePath: projectStateDir(runtime.projectHome),
      });
      return {
        configPath,
        registryPath,
        dispose: Effect.tryPromise({
          try: async () => {
            await rm(tempDir, { recursive: true, force: true });
          },
          catch: (cause) => ({
            _tag: "AoRuntimeDisposeFailed",
            cause: cause instanceof Error ? cause.message : String(cause),
          } satisfies AoRuntimeDisposeError),
        }),
      } satisfies AoRuntimeHandle;
    },
    catch: (cause) => ({
      _tag: "AoConfigMaterializationFailed",
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies AoRuntimeMaterializationError),
  });
}

export function resolveProjectBinding(
  runtime: ResolvedProjectRuntime,
  checkoutPath: RepoCheckoutPath,
): { readonly checkoutPath: RepoCheckoutPath; readonly routes: ReadonlyArray<{ readonly repo: RepoFullName; readonly projectName: ProjectName }> } {
  return {
    checkoutPath,
    routes: Array.from(runtime.routes.values()).map((route) => ({
      repo: route.repo,
      projectName: route.projectName,
    })),
  };
}

function buildAoRuntimeYaml(runtime: ResolvedProjectRuntime): string {
  const projects = Object.fromEntries(
    Array.from(runtime.routes.values()).map((route) => [
      route.projectName,
      {
        repo: route.repo,
        path: route.checkoutPath,
        defaultBranch: route.defaultBranch,
        scm: {
          plugin: "github",
          webhook: {
            path: "/api/webhooks/github",
            secretEnvVar: "__CANONICAL_ZAPBOT_WEBHOOK_SECRET__",
            signatureHeader: "x-hub-signature-256",
            eventHeader: "x-github-event",
          },
        },
      },
    ]),
  );

  return stringifyYaml({
    port: runtime.aoPort,
    projects,
  });
}
