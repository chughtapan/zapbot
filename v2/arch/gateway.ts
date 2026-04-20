import type {
  BotUsername,
  CommentId,
  DeliveryId,
  GatewayError,
  IssueNumber,
  MentionCommand,
  RepoFullName,
  Result,
  WebhookIntakeError,
} from "../types.ts";

export interface GatewayClientConfig {
  readonly gatewayUrl: string;
  readonly secret: string | null;
  readonly token: string | null;
}

export interface GatewayWebhookEnvelope {
  readonly rawBody: string;
  readonly signature: string | null;
  readonly eventType: string;
  readonly deliveryId: DeliveryId;
  readonly repo: RepoFullName;
  readonly payload: unknown;
}

export type ClassifiedWebhook =
  | { readonly kind: "ignore"; readonly reason: string }
  | {
      readonly kind: "mention_command";
      readonly repo: RepoFullName;
      readonly issue: IssueNumber;
      readonly commentId: CommentId;
      readonly command: MentionCommand;
      readonly triggeredBy: string;
    };

export function registerBridge(
  config: GatewayClientConfig,
  repo: RepoFullName,
  bridgeUrl: string,
): Promise<Result<void, GatewayError>> {
  throw new Error("not implemented");
}

export function deregisterBridge(
  config: GatewayClientConfig,
  repo: RepoFullName,
  bridgeUrl: string,
): Promise<Result<void, GatewayError>> {
  throw new Error("not implemented");
}

export function startHeartbeat(
  config: GatewayClientConfig,
  repos: ReadonlyArray<RepoFullName>,
  bridgeUrl: string,
  intervalMs: number,
): () => void {
  throw new Error("not implemented");
}

export function verifyAndClassify(
  envelope: GatewayWebhookEnvelope,
  resolveSecret: (repo: RepoFullName) => string | null,
  botUsername: BotUsername,
): Promise<Result<ClassifiedWebhook, WebhookIntakeError>> {
  throw new Error("not implemented");
}
