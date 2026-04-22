import { Effect } from "effect";
import type { ResolvedProjectRuntime } from "../config/schema.ts";
import {
  createGitHubClient,
  getInstallationToken,
  type GitHubClient,
  type GitHubClientInitError,
  type InstallationTokenPair,
} from "../github/client.ts";
import { createGitHubStateService, type GitHubStateService } from "../github-state.ts";
import {
  createLoggerFactory,
  type Logger,
  type LoggerFactory,
} from "../logger.ts";

export interface RuntimeServices {
  readonly loggerFactory: LoggerFactory;
  readonly githubClient: GitHubClient;
  readonly githubState: GitHubStateService;
  readonly mintInstallationToken: () => Promise<InstallationTokenPair | null>;
}

export type RuntimeServicesError =
  | { readonly _tag: "GitHubClientInitFailed"; readonly cause: string }
  | { readonly _tag: "LoggerConfigInvalid"; readonly cause: string };

export function createRuntimeServices(
  runtime: ResolvedProjectRuntime,
): Effect.Effect<RuntimeServices, RuntimeServicesError, never> {
  return Effect.gen(function* () {
    const loggerFactory = yield* createLoggerFactory(runtime.logLevel).pipe(
      Effect.mapError((cause): RuntimeServicesError => ({
        _tag: "LoggerConfigInvalid",
        cause,
      })),
    );
    const githubLog = loggerFactory.create("github");
    const client = yield* createGitHubClient(runtime.githubAuth, githubLog).pipe(
      Effect.mapError((error): RuntimeServicesError => ({
        _tag: "GitHubClientInitFailed",
        cause: formatGitHubInitError(error),
      })),
    );
    const stateLog = loggerFactory.create("github-state");
    const githubState = createGitHubStateService(runtime.githubAuth, stateLog);
    return {
      loggerFactory,
      githubClient: client,
      githubState,
      mintInstallationToken: async () => {
        try {
          return await Effect.runPromise(getInstallationToken(runtime.githubAuth));
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }
      },
    } satisfies RuntimeServices;
  });
}

function formatGitHubInitError(error: GitHubClientInitError): string {
  switch (error._tag) {
    case "GitHubAuthInvalid":
      return error.cause;
    default:
      return error.cause;
  }
}
