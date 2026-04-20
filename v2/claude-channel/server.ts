/**
 * v2/claude-channel/server — session-local MCP server that exposes the
 * official Claude Code channel contract over stdio.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { MoltzapConversationId } from "../moltzap/types.ts";
import { asMoltzapSenderId, type MoltzapSenderId } from "../moltzap/types.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Notification, Result as McpResult, Request } from "@modelcontextprotocol/sdk/types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  ClaudeChannelNotification,
  ClaudeChannelPermissionNotification,
} from "./event.ts";

export interface ClaudeChannelReplyArgs {
  readonly conversationId: MoltzapConversationId;
  readonly text: string;
}

export interface ClaudeDirectMessageArgs {
  readonly recipientId: MoltzapSenderId;
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
  readonly enableDirectMessageTool?: boolean;
  readonly enablePermissionRelay: boolean;
}

export interface ClaudeChannelServerDeps {
  readonly sendReply: (
    args: ClaudeChannelReplyArgs,
  ) => Promise<Result<void, ClaudeChannelReplyError>>;
  readonly sendDirectMessage?: (
    args: ClaudeDirectMessageArgs,
  ) => Promise<Result<MoltzapConversationId, ClaudeChannelDirectMessageError>>;
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
  | { readonly _tag: "DirectMessageToolRegistrationFailed"; readonly cause: string }
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

export type ClaudeChannelDirectMessageError = {
  readonly _tag: "DirectMessageFailed";
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
  if (config.enablePermissionRelay && deps.forwardPermissionRequest === undefined) {
    return err({
      _tag: "PermissionRelayRegistrationFailed",
      cause: "forwardPermissionRequest is required when permission relay is enabled",
    });
  }
  if (config.enableDirectMessageTool === true && deps.sendDirectMessage === undefined) {
    return err({
      _tag: "DirectMessageToolRegistrationFailed",
      cause: "sendDirectMessage is required when the direct message tool is enabled",
    });
  }

  const server = new Server<Request, Notification, McpResult>(
    {
      name: config.serverName,
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: config.enableReplyTool ? {} : undefined,
        experimental: {
          "claude/channel": {},
          ...(config.enablePermissionRelay ? { "claude/channel/permission": {} } : {}),
        },
      },
      instructions: config.instructions,
    },
  );
  let initialized = false;
  const pendingNotifications: Notification[] = [];
  server.oninitialized = () => {
    initialized = true;
    void flushPendingNotifications(server, pendingNotifications);
  };

  try {
    server.setRequestHandler(
      ListToolsRequestSchema,
      async () => listTools(config.enableReplyTool, config.enableDirectMessageTool === true),
    );
    server.setRequestHandler(CallToolRequestSchema, async (request) =>
      handleToolCall(request.params.name, request.params.arguments, config, deps),
    );
  } catch (cause) {
    return err({
      _tag: "ReplyToolRegistrationFailed",
      cause: stringifyCause(cause),
    });
  }

  server.fallbackNotificationHandler = async (notification) => {
    if (!config.enablePermissionRelay || notification.method !== PERMISSION_REQUEST_METHOD) {
      return;
    }
    const parsed = parsePermissionRequest(notification);
    if (parsed === null) {
      return;
    }
    const forwarded = await deps.forwardPermissionRequest!(parsed);
    if (forwarded._tag === "Err") {
      throw new Error(forwarded.error.cause);
    }
  };

  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (cause) {
    return err({
      _tag: "StdioConnectFailed",
      cause: stringifyCause(cause),
    });
  }

  return ok({
    push: async (notification) => {
      try {
        await emitNotification(server, notification as unknown as Notification, {
          initialized,
          pendingNotifications,
        });
        return ok(undefined);
      } catch (cause) {
        return err({ _tag: "EmitFailed", cause: stringifyCause(cause) });
      }
    },
    pushPermissionVerdict: async (notification) => {
      if (!config.enablePermissionRelay) {
        return err({
          _tag: "EmitFailed",
          cause: "permission relay is disabled for this channel server",
        });
      }
      try {
        await emitNotification(server, notification as unknown as Notification, {
          initialized,
          pendingNotifications,
        });
        return ok(undefined);
      } catch (cause) {
        return err({ _tag: "EmitFailed", cause: stringifyCause(cause) });
      }
    },
    stop: async () => {
      try {
        await server.close();
        return ok(undefined);
      } catch (cause) {
        return err({ _tag: "StopFailed", cause: stringifyCause(cause) });
      }
    },
  });
}

const REPLY_TOOL_NAME = "reply";
const SEND_DIRECT_MESSAGE_TOOL_NAME = "send_direct_message";
const PERMISSION_REQUEST_METHOD = "notifications/claude/channel/permission_request";

function listTools(enableReplyTool: boolean, enableDirectMessageTool: boolean): ListToolsResult {
  const tools: ListToolsResult["tools"] = [];
  if (enableReplyTool) {
    tools.push(
      {
        name: REPLY_TOOL_NAME,
        description: "Reply into the active MoltZap conversation for this Claude channel.",
        inputSchema: {
          type: "object",
          properties: {
            conversationId: {
              type: "string",
              description: "Conversation ID to send the reply into.",
            },
            text: {
              type: "string",
              description: "Reply text to send back over MoltZap.",
            },
          },
          required: ["conversationId", "text"],
        },
        annotations: {
          title: "Reply",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    );
  }
  if (enableDirectMessageTool) {
    tools.push({
      name: SEND_DIRECT_MESSAGE_TOOL_NAME,
      description:
        "Start or reuse a MoltZap DM with another agent sender ID and send a text message.",
      inputSchema: {
        type: "object",
        properties: {
          recipientId: {
            type: "string",
            description: "Recipient agent sender ID.",
          },
          text: {
            type: "string",
            description: "Message text to send to the recipient.",
          },
        },
        required: ["recipientId", "text"],
      },
      annotations: {
        title: "Send Direct Message",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    });
  }
  return {
    tools,
  };
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
  config: ClaudeChannelServerConfig,
  deps: ClaudeChannelServerDeps,
): Promise<CallToolResult> {
  switch (name) {
    case REPLY_TOOL_NAME: {
      if (!config.enableReplyTool) {
        return toolError("reply tool is disabled");
      }
      const parsed = parseReplyArgs(args);
      if (parsed === null) {
        return toolError("reply requires string conversationId and non-empty text");
      }
      const sent = await deps.sendReply(parsed);
      if (sent._tag === "Err") {
        return toolError(sent.error.cause);
      }
      return {
        content: [
          {
            type: "text",
            text: `Reply sent to conversation ${parsed.conversationId as string}.`,
          },
        ],
      };
    }
    case SEND_DIRECT_MESSAGE_TOOL_NAME: {
      if (config.enableDirectMessageTool !== true || deps.sendDirectMessage === undefined) {
        return toolError("send_direct_message tool is disabled");
      }
      const parsed = parseDirectMessageArgs(args);
      if (parsed === null) {
        return toolError("send_direct_message requires string recipientId and non-empty text");
      }
      const sent = await deps.sendDirectMessage(parsed);
      if (sent._tag === "Err") {
        return toolError(sent.error.cause);
      }
      return {
        content: [
          {
            type: "text",
            text: `Direct message sent to ${parsed.recipientId as string} via conversation ${sent.value as string}.`,
          },
        ],
      };
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

function parseReplyArgs(
  args: Record<string, unknown> | undefined,
): ClaudeChannelReplyArgs | null {
  if (args === undefined) {
    return null;
  }
  const conversationId =
    typeof args.conversationId === "string"
      ? args.conversationId
      : typeof args.conversation_id === "string"
        ? args.conversation_id
        : null;
  const text = typeof args.text === "string" ? args.text : null;
  if (conversationId === null || conversationId.trim().length === 0) {
    return null;
  }
  if (text === null || text.trim().length === 0) {
    return null;
  }
  return {
    conversationId: conversationId as MoltzapConversationId,
    text,
  };
}

function parseDirectMessageArgs(
  args: Record<string, unknown> | undefined,
): ClaudeDirectMessageArgs | null {
  if (args === undefined) {
    return null;
  }
  const recipientId =
    typeof args.recipientId === "string"
      ? args.recipientId
      : typeof args.recipient_id === "string"
        ? args.recipient_id
        : null;
  const text = typeof args.text === "string" ? args.text : null;
  if (recipientId === null || recipientId.trim().length === 0) {
    return null;
  }
  if (text === null || text.trim().length === 0) {
    return null;
  }
  return {
    recipientId: asMoltzapSenderId(recipientId.trim()),
    text,
  };
}

function parsePermissionRequest(notification: Notification): ClaudePermissionRequest | null {
  if (typeof notification.params !== "object" || notification.params === null) {
    return null;
  }
  const params = notification.params as Record<string, unknown>;
  const requestId =
    typeof params.request_id === "string"
      ? params.request_id
      : typeof params.requestId === "string"
        ? params.requestId
        : null;
  const toolName =
    typeof params.tool_name === "string"
      ? params.tool_name
      : typeof params.toolName === "string"
        ? params.toolName
        : null;
  const description = typeof params.description === "string" ? params.description : "";
  const inputPreview =
    typeof params.input_preview === "string"
      ? params.input_preview
      : typeof params.inputPreview === "string"
        ? params.inputPreview
        : "";
  if (requestId === null || requestId.trim().length === 0 || toolName === null || toolName.trim().length === 0) {
    return null;
  }
  return {
    requestId,
    toolName,
    description,
    inputPreview,
  };
}

function toolError(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function emitNotification(
  server: Server<Request, Notification, McpResult>,
  notification: Notification,
  state: {
    readonly initialized: boolean;
    readonly pendingNotifications: Notification[];
  },
): Promise<void> {
  if (!state.initialized) {
    state.pendingNotifications.push(notification);
    return;
  }
  await server.notification(notification);
}

async function flushPendingNotifications(
  server: Server<Request, Notification, McpResult>,
  pendingNotifications: Notification[],
): Promise<void> {
  while (pendingNotifications.length > 0) {
    const notification = pendingNotifications.shift();
    if (notification === undefined) {
      return;
    }
    await server.notification(notification);
  }
}
