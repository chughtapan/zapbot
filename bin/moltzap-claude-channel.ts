#!/usr/bin/env bun

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import type { EventFrame, Message as MoltzapMessage } from "@moltzap/protocol";
import { EventNames } from "@moltzap/protocol";
import { MoltZapService, MoltZapWsClient } from "@moltzap/client";
import { toClaudeChannelNotification } from "../src/claude-channel/event.ts";
import {
  bootClaudeChannelServer,
  type ClaudeChannelServerHandle,
} from "../src/claude-channel/server.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
  type MoltzapConversationId,
  type MoltzapSenderId,
} from "../src/moltzap/types.ts";
import { err, ok, type Result } from "../src/types.ts";

type SessionRole = "orchestrator" | "worker";

interface SessionBootstrap {
  readonly role: SessionRole;
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly localSenderId: MoltzapSenderId | null;
  readonly orchestratorSenderId: MoltzapSenderId | null;
}

interface RegistrationPayload {
  readonly apiKey: string;
  readonly agentId: string;
}

interface MoltzapMessageLike {
  readonly id: string;
  readonly conversationId: string;
  readonly createdAt: string;
  readonly sender?: { readonly id: string };
  readonly senderId?: string;
  readonly text?: string;
  readonly parts?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
}

const debugLogPath = resolveDebugLogPath(process.env);
logDebug("boot");
process.on("beforeExit", (code) => {
  logDebug(`beforeExit code=${code}`);
});
process.on("exit", (code) => {
  logDebug(`exit code=${code}`);
});
process.on("uncaughtException", (cause) => {
  logDebug(`uncaughtException ${stringifyCause(cause)}`);
});
process.on("unhandledRejection", (cause) => {
  logDebug(`unhandledRejection ${stringifyCause(cause)}`);
});
process.stdin.on("close", () => {
  logDebug("stdin close");
});
process.stdin.on("end", () => {
  logDebug("stdin end");
});
process.stdin.on("error", (cause) => {
  logDebug(`stdin error ${stringifyCause(cause)}`);
});

const role: SessionRole = process.env.AO_CALLER_TYPE === "orchestrator" ? "orchestrator" : "worker";
const bootstrap = await resolveBootstrap(process.env, role);
if (bootstrap._tag === "Err") {
  fatal(bootstrap.error);
}

const service = new MoltZapService({
  serverUrl: bootstrap.value.serverUrl,
  agentKey: bootstrap.value.apiKey,
});

let channelStop: (() => Promise<void>) | null = null;
let unreadPoller: ReturnType<typeof setInterval> | null = null;
let eventClient: MoltZapWsClient | null = null;

try {
  const hello = await service.connect();
  const localSenderId = asMoltzapSenderId(
    bootstrap.value.localSenderId ?? hello.agentId,
  );
  if (role === "worker" && bootstrap.value.orchestratorSenderId === null) {
    fatal("worker sessions require MOLTZAP_ORCHESTRATOR_SENDER_ID");
  }

  writeMetadataKey("moltzap_sender_id", localSenderId);
  writeMetadataKey("moltzap_api_key", bootstrap.value.apiKey);
  writeMetadataKey("moltzap_server_url", bootstrap.value.serverUrl);

  const dmCache = new Map<string, string>();
  const deliveredMessageIds = new Set<string>();
  const channel = await bootClaudeChannelServer(
    {
      serverName: "moltzap",
      instructions: buildInstructions(role, bootstrap.value.orchestratorSenderId),
      enableReplyTool: true,
      enableDirectMessageTool: true,
      enablePermissionRelay: false,
    },
    {
      sendReply: async ({ conversationId, text }) => {
        try {
          await service.send(conversationId as string, text);
          return ok(undefined);
        } catch (cause) {
          return err({
            _tag: "ReplyFailed",
            cause: stringifyCause(cause),
          });
        }
      },
      sendDirectMessage: async ({ recipientId, text }) => {
        try {
          const conversationId = await ensureDirectConversation(
            service,
            dmCache,
            recipientId,
          );
          await service.send(conversationId, text);
          return ok(asMoltzapConversationId(conversationId));
        } catch (cause) {
          return err({
            _tag: "DirectMessageFailed",
            cause: stringifyCause(cause),
          });
        }
      },
    },
  );
  if (channel._tag === "Err") {
    fatal(channel.error.cause);
  }

  eventClient = new MoltZapWsClient({
    serverUrl: bootstrap.value.serverUrl,
    agentKey: bootstrap.value.apiKey,
    onEvent: (frame) => {
      const message = messageFromEventFrame(frame);
      if (message === null) {
        return;
      }
      void emitClaudeNotification({
        channel: channel.value,
        message,
        localSenderId,
        deliveredMessageIds,
      });
    },
    onDisconnect: () => {
      console.error("[moltzap-channel] disconnected");
    },
    onReconnect: () => {
      console.error("[moltzap-channel] reconnected");
      void sweepUnreadConversations({
        service,
        channel: channel.value,
        localSenderId,
        deliveredMessageIds,
      });
    },
  });
  await eventClient.connect();

  channelStop = async () => {
    if (unreadPoller !== null) {
      clearInterval(unreadPoller);
      unreadPoller = null;
    }
    eventClient?.close();
    eventClient = null;
    await channel.value.stop();
    service.close();
  };

  console.error(
    `[moltzap-channel] ready agent=${localSenderId as string} server=${bootstrap.value.serverUrl} role=${role}`,
  );
  logDebug(
    `ready agent=${localSenderId as string} server=${bootstrap.value.serverUrl} role=${role}`,
  );
  await sweepUnreadConversations({ service, channel: channel.value, localSenderId, deliveredMessageIds });
  unreadPoller = setInterval(() => {
    void sweepUnreadConversations({
      service,
      channel: channel.value,
      localSenderId,
      deliveredMessageIds,
    });
  }, 2_000);

  const keepAlive = setInterval(() => {}, 1_000);
  async function shutdown(signal: string): Promise<void> {
    clearInterval(keepAlive);
    console.error(`[moltzap-channel] stopping on ${signal}`);
    logDebug(`shutdown ${signal}`);
    await channelStop?.();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
} catch (cause) {
  if (channelStop !== null) {
    await channelStop().catch(() => undefined);
  } else {
    service.close();
  }
  fatal(stringifyCause(cause));
}

async function resolveBootstrap(
  env: Record<string, string | undefined>,
  role: SessionRole,
): Promise<Result<SessionBootstrap, string>> {
  const serverUrl = normalizeServerUrl(env.MOLTZAP_SERVER_URL);
  if (serverUrl === null) {
    return err("MOLTZAP_SERVER_URL is required");
  }

  const apiKey = trimEnv(env.MOLTZAP_API_KEY);
  const registrationSecret = trimEnv(env.MOLTZAP_REGISTRATION_SECRET);
  const orchestratorSenderId = trimEnv(env.MOLTZAP_ORCHESTRATOR_SENDER_ID);
  if (role === "worker" && orchestratorSenderId === null) {
    return err("MOLTZAP_ORCHESTRATOR_SENDER_ID is required for worker sessions");
  }

  if (apiKey !== null) {
    const localSenderId = trimEnv(env.MOLTZAP_LOCAL_SENDER_ID);
    return ok({
      role,
      serverUrl,
      apiKey,
      localSenderId: localSenderId === null ? null : asMoltzapSenderId(localSenderId),
      orchestratorSenderId:
        orchestratorSenderId === null ? null : asMoltzapSenderId(orchestratorSenderId),
    });
  }

  if (registrationSecret === null) {
    return err("either MOLTZAP_API_KEY or MOLTZAP_REGISTRATION_SECRET is required");
  }

  const registration = await registerAgent(
    serverUrl,
    registrationSecret,
    buildAgentName(env, role),
  );
  if (registration._tag === "Err") {
    return registration;
  }
  return ok({
    role,
    serverUrl,
    apiKey: registration.value.apiKey,
    localSenderId: asMoltzapSenderId(registration.value.agentId),
    orchestratorSenderId:
      orchestratorSenderId === null ? null : asMoltzapSenderId(orchestratorSenderId),
  });
}

async function registerAgent(
  serverUrl: string,
  registrationSecret: string,
  agentName: string,
): Promise<Result<RegistrationPayload, string>> {
  let response: Response;
  try {
    response = await fetch(`${toHttpBaseUrl(serverUrl)}/api/v1/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: agentName,
        description: `zapbot ${role} channel session ${process.env.AO_SESSION_NAME ?? process.env.AO_SESSION ?? agentName}`,
        inviteCode: registrationSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    return err(`registration failed: ${stringifyCause(cause)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return err(`registration failed (${response.status}): ${body || "empty response"}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    return err(`registration returned invalid JSON: ${stringifyCause(cause)}`);
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    typeof (payload as RegistrationPayload).apiKey !== "string" ||
    typeof (payload as RegistrationPayload).agentId !== "string"
  ) {
    return err("registration response missing string apiKey or agentId");
  }
  return ok({
    apiKey: (payload as RegistrationPayload).apiKey,
    agentId: (payload as RegistrationPayload).agentId,
  });
}

async function ensureDirectConversation(
  service: MoltZapService,
  dmCache: Map<string, string>,
  recipientId: MoltzapSenderId,
): Promise<string> {
  const cached = dmCache.get(recipientId as string);
  if (cached !== undefined) {
    return cached;
  }
  const created = (await service.sendRpc("conversations/create", {
    type: "dm",
    participants: [{ type: "agent", id: recipientId }],
  })) as { conversation: { id: string } };
  const conversationId = created.conversation.id;
  dmCache.set(recipientId as string, conversationId);
  return conversationId;
}

function buildInstructions(
  role: SessionRole,
  orchestratorSenderId: MoltzapSenderId | null,
): string {
  return [
    `This session is connected to MoltZap as a ${role}.`,
    "Messages from other agents arrive over this Claude channel.",
    "Use the reply tool to answer the current MoltZap conversation.",
    "Use send_direct_message to start or reuse a direct DM with another agent sender ID.",
    orchestratorSenderId !== null
      ? `The orchestrator sender ID is ${orchestratorSenderId as string}.`
      : "No orchestrator sender ID is configured for this session.",
  ].join("\n\n");
}

function normalizeServerUrl(raw: string | undefined): string | null {
  const trimmed = trimEnv(raw);
  if (trimmed === null) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return null;
    }
    if (url.pathname === "/ws" || url.pathname === "/ws/") {
      url.pathname = "/";
    } else if (url.pathname.endsWith("/ws")) {
      url.pathname = url.pathname.slice(0, -3) || "/";
    }
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function toHttpBaseUrl(serverUrl: string): string {
  return serverUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
}

function buildAgentName(
  env: Record<string, string | undefined>,
  role: SessionRole,
): string {
  const seed =
    trimEnv(env.AO_SESSION_NAME) ??
    trimEnv(env.AO_SESSION) ??
    `${role}-${Date.now()}`;
  const raw = `zb-${seed}`.toLowerCase();
  const sanitized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 32)
    .replace(/[^a-z0-9]+$/, "");
  return sanitized.length >= 3 ? sanitized : `zb-${role}-${Date.now().toString(36)}`;
}

function writeMetadataKey(key: string, value: string): void {
  const dataDir = trimEnv(process.env.AO_DATA_DIR);
  const sessionId = trimEnv(process.env.AO_SESSION);
  if (dataDir === null || sessionId === null) {
    return;
  }
  const path = `${dataDir}/${sessionId}`;
  let lines: string[] = [];
  try {
    lines = readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return;
  }
  const nextLine = `${key}=${value}`;
  const updated = [];
  let replaced = false;
  for (const line of lines) {
    if (line.startsWith(`${key}=`)) {
      updated.push(nextLine);
      replaced = true;
    } else {
      updated.push(line);
    }
  }
  if (!replaced) {
    updated.push(nextLine);
  }
  writeFileSync(path, `${updated.join("\n")}\n`, "utf8");
}

interface ConversationListResult {
  readonly conversations: ReadonlyArray<{
    readonly id: string;
    readonly unreadCount?: number;
  }>;
}

interface MessageListResult {
  readonly messages: ReadonlyArray<MoltzapMessage>;
}

async function sweepUnreadConversations(options: {
  readonly service: MoltZapService;
  readonly channel: ClaudeChannelServerHandle;
  readonly localSenderId: MoltzapSenderId;
  readonly deliveredMessageIds: Set<string>;
}): Promise<void> {
  let listed: ConversationListResult;
  try {
    listed = (await options.service.sendRpc("conversations/list", {})) as ConversationListResult;
  } catch (cause) {
    console.error(`[moltzap-channel] unread poll failed: ${stringifyCause(cause)}`);
    return;
  }

  for (const conversation of listed.conversations) {
    if ((conversation.unreadCount ?? 0) <= 0) {
      continue;
    }

    let history: MessageListResult;
    try {
      history = (await options.service.sendRpc("messages/list", {
        conversationId: conversation.id,
        limit: Math.max(20, conversation.unreadCount ?? 0),
      })) as MessageListResult;
    } catch (cause) {
      console.error(
        `[moltzap-channel] unread history fetch failed for ${conversation.id}: ${stringifyCause(cause)}`,
      );
      continue;
    }

    const ordered = [...history.messages].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    for (const message of ordered) {
      const senderId = extractSenderId(message as MoltzapMessageLike);
      if (senderId === (options.localSenderId as string)) {
        continue;
      }
      await emitClaudeNotification({
        channel: options.channel,
        message,
        localSenderId: options.localSenderId,
        deliveredMessageIds: options.deliveredMessageIds,
      });
    }
  }
}

async function emitClaudeNotification(options: {
  readonly channel: ClaudeChannelServerHandle;
  readonly message: MoltzapMessageLike;
  readonly localSenderId: MoltzapSenderId;
  readonly deliveredMessageIds: Set<string>;
}): Promise<void> {
  if (options.deliveredMessageIds.has(options.message.id)) {
    return;
  }

  const senderId = extractSenderId(options.message);
  if (senderId === null) {
    logDebug(`skip message ${options.message.id}: sender missing`);
    return;
  }
  if (senderId === (options.localSenderId as string)) {
    return;
  }
  const bodyText = extractBodyText(options.message);
  if (bodyText.length === 0) {
    return;
  }
  const notification = toClaudeChannelNotification({
    conversationId: asMoltzapConversationId(options.message.conversationId),
    messageId: asMoltzapMessageId(options.message.id),
    senderId: asMoltzapSenderId(senderId),
    bodyText,
    receivedAtMs: Date.parse(options.message.createdAt),
  });
  if (notification._tag === "Err") {
    console.error(`[moltzap-channel] skipped inbound message: ${notification.error._tag}`);
    return;
  }
  const pushed = await options.channel.push(notification.value);
  if (pushed._tag === "Err") {
    console.error(`[moltzap-channel] failed to emit notification: ${pushed.error.cause}`);
    return;
  }
  options.deliveredMessageIds.add(options.message.id);
  console.error(
    `[moltzap-channel] delivered message ${options.message.id} from ${senderId} into Claude conversation ${options.message.conversationId}`,
  );
}

function trimEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function messageFromEventFrame(frame: EventFrame): MoltzapMessageLike | null {
  if (frame.event !== EventNames.MessageReceived) {
    return null;
  }
  if (typeof frame.data !== "object" || frame.data === null) {
    return null;
  }
  const nested = asMessageLike((frame.data as { readonly message?: unknown }).message);
  if (nested !== null) {
    return nested;
  }
  return asMessageLike(frame.data);
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function fatal(message: string): never {
  logDebug(`fatal ${message}`);
  console.error(`[moltzap-channel] ${message}`);
  process.exit(1);
}

function resolveDebugLogPath(env: Record<string, string | undefined>): string {
  const explicit = trimEnv(env.MOLTZAP_CHANNEL_DEBUG_LOG_PATH);
  if (explicit !== null) {
    return explicit;
  }
  const sessionName = trimEnv(env.AO_SESSION_NAME) ?? trimEnv(env.AO_SESSION) ?? `pid-${process.pid}`;
  return join("/tmp", `moltzap-channel-${sessionName}.log`);
}

function logDebug(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    mkdirSync(dirname(debugLogPath), { recursive: true });
    appendFileSync(debugLogPath, line, "utf8");
  } catch {
    // Best-effort debug logging only.
  }
}

function asMessageLike(candidate: unknown): MoltzapMessageLike | null {
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const message = candidate as Partial<MoltzapMessageLike>;
  if (
    typeof message.id !== "string" ||
    typeof message.conversationId !== "string" ||
    typeof message.createdAt !== "string"
  ) {
    return null;
  }
  return message as MoltzapMessageLike;
}

function extractSenderId(message: MoltzapMessageLike): string | null {
  if (typeof message.sender?.id === "string" && message.sender.id.length > 0) {
    return message.sender.id;
  }
  if (typeof message.senderId === "string" && message.senderId.length > 0) {
    return message.senderId;
  }
  return null;
}

function extractBodyText(message: MoltzapMessageLike): string {
  if (typeof message.text === "string") {
    return message.text.trim();
  }
  if (!Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
}
