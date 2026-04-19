/**
 * v2/claude-channel/server — session-local MCP server that exposes the
 * official Claude Code channel contract over stdio.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import type { MoltzapConversationId } from "../moltzap/types.ts";
import type {
  ClaudeChannelNotification,
  ClaudeChannelPermissionNotification,
} from "./event.ts";

export interface ClaudeChannelReplyArgs {
  readonly conversationId: MoltzapConversationId;
  readonly text: string;
}

export interface ClaudePermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputPreview: string;
}

export interface ClaudeChannelServerConfig {
  readonly serverName: string;
  readonly instructions: string;
  readonly enableReplyTool: boolean;
  readonly enablePermissionRelay: boolean;
}

export interface ClaudeChannelServerDeps {
  readonly sendReply: (
    args: ClaudeChannelReplyArgs,
  ) => Promise<Result<void, ClaudeChannelReplyError>>;
  readonly forwardPermissionRequest?: (
    request: ClaudePermissionRequest,
  ) => Promise<Result<void, ClaudeChannelPermissionRequestError>>;
}

export interface ClaudeChannelServerHandle {
  readonly push: (
    notification: ClaudeChannelNotification,
  ) => Promise<Result<void, ClaudeChannelEmitError>>;
  readonly pushPermissionVerdict: (
    notification: ClaudeChannelPermissionNotification,
  ) => Promise<Result<void, ClaudeChannelEmitError>>;
  readonly stop: () => Promise<Result<void, ClaudeChannelStopError>>;
}

export type ClaudeChannelServerBootError =
  | { readonly _tag: "StdioConnectFailed"; readonly cause: string }
  | { readonly _tag: "ReplyToolRegistrationFailed"; readonly cause: string }
  | {
      readonly _tag: "PermissionRelayRegistrationFailed";
      readonly cause: string;
    };

export type ClaudeChannelEmitError = {
  readonly _tag: "EmitFailed";
  readonly cause: string;
};

export type ClaudeChannelReplyError = {
  readonly _tag: "ReplyFailed";
  readonly cause: string;
};

export type ClaudeChannelPermissionRequestError = {
  readonly _tag: "PermissionRequestForwardFailed";
  readonly cause: string;
};

export type ClaudeChannelStopError = {
  readonly _tag: "StopFailed";
  readonly cause: string;
};

/**
 * Boot the session-local MCP server that Claude Code treats as a custom
 * channel during research-preview development mode.
 */
export async function bootClaudeChannelServer(
  config: ClaudeChannelServerConfig,
  deps: ClaudeChannelServerDeps,
): Promise<Result<ClaudeChannelServerHandle, ClaudeChannelServerBootError>> {
  throw new Error("not implemented");
}
