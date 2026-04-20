import type {
  BotUsername,
  CommentId,
  DispatchError,
  HandleOutcome,
  InstallationToken,
  IssueNumber,
  MentionCommand,
  ProjectName,
  RepoFullName,
  Result,
} from "../types.ts";
import type { MoltzapRuntimeConfig } from "./provisioning.ts";

export interface BridgeRuntimeConfig {
  readonly port: number;
  readonly publicUrl: string;
  readonly gatewayUrl: string;
  readonly gatewaySecret: string | null;
  readonly botUsername: BotUsername;
  readonly aoConfigPath: string;
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly moltzap: MoltzapRuntimeConfig;
  readonly repos: ReadonlyMap<RepoFullName, RepoRoute>;
}

export interface RepoRoute {
  readonly projectName: ProjectName;
  readonly webhookSecretEnvVar: string;
  readonly defaultBranch: string;
}

export interface RunningBridge {
  readonly stop: () => Promise<void>;
  readonly reload: (nextConfig: BridgeRuntimeConfig) => Promise<void>;
}

export interface BridgeHandlerContext {
  readonly mintToken: () => Promise<Result<InstallationToken, DispatchError>>;
  readonly gh: GhAdapter;
  readonly config: BridgeRuntimeConfig;
}

export interface GhAdapter {
  readonly addReaction: (repo: RepoFullName, commentId: CommentId, reaction: string) => Promise<Result<void, GhCallError>>;
  readonly getUserPermission: (repo: RepoFullName, user: string) => Promise<Result<string, GhCallError>>;
  readonly postComment: (repo: RepoFullName, issue: IssueNumber, body: string) => Promise<Result<void, GhCallError>>;
}

export type GhCallError = {
  readonly _tag: "GhCallFailed";
  readonly label: string;
  readonly cause: string;
};

export type BridgeConfigError =
  | { readonly _tag: "BridgeEnvInvalid"; readonly reason: string }
  | { readonly _tag: "BridgeRepoMapInvalid"; readonly repo: RepoFullName; readonly reason: string };

export type BridgeRuntimeError =
  | { readonly _tag: "BridgeStartFailed"; readonly cause: string }
  | { readonly _tag: "BridgeReloadFailed"; readonly cause: string };

export function buildBridgeRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): Result<BridgeRuntimeConfig, BridgeConfigError> {
  throw new Error("not implemented");
}

export function startBridgeRuntime(
  config: BridgeRuntimeConfig,
): Promise<Result<RunningBridge, BridgeRuntimeError>> {
  throw new Error("not implemented");
}

export function handleClassifiedWebhook(
  classified:
    | { readonly kind: "ignore"; readonly reason: string }
    | {
        readonly kind: "mention_command";
        readonly repo: RepoFullName;
        readonly issue: IssueNumber;
        readonly commentId: CommentId;
        readonly command: MentionCommand;
        readonly triggeredBy: string;
      },
  ctx: BridgeHandlerContext,
): Promise<Result<HandleOutcome, DispatchError>> {
  throw new Error("not implemented");
}
