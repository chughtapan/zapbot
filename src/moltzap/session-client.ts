/**
 * moltzap/session-client — load `MOLTZAP_*` env inside an AO session and
 * connect an authenticated MoltZap client.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { MoltzapSdkHandle, MoltzapSenderId } from "./types.ts";
import { asMoltzapSenderId } from "./types.ts";

export type SessionRole = "orchestrator" | "worker";

export interface SessionClientEnv {
  readonly role: SessionRole;
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly localSenderId: MoltzapSenderId;
  readonly orchestratorSenderId: MoltzapSenderId | null;
  readonly allowlistCsv: string | null;
}

export interface SessionClientHandle {
  readonly role: SessionRole;
  readonly normalizedServerUrl: string;
  readonly sdk: MoltzapSdkHandle;
  readonly localSenderId: MoltzapSenderId;
  readonly orchestratorSenderId: MoltzapSenderId | null;
  readonly close: () => Promise<Result<void, SessionClientDisconnectError>>;
}

export interface SessionClientConnector {
  readonly connect: (
    env: SessionClientEnv,
  ) => Promise<Result<MoltzapSdkHandle, Extract<SessionClientConnectError, { readonly _tag: "ConnectFailed" }>>>;
  readonly disconnect: (
    sdk: MoltzapSdkHandle,
  ) => Promise<Result<void, SessionClientDisconnectError>>;
}

export type SessionClientConfigError =
  | { readonly _tag: "MissingServerUrl" }
  | { readonly _tag: "MissingApiKey" }
  | { readonly _tag: "MissingLocalSenderId" }
  | { readonly _tag: "MissingOrchestratorSenderId"; readonly role: "worker" }
  | { readonly _tag: "InvalidServerUrl"; readonly value: string };

export type SessionClientConnectError =
  | { readonly _tag: "ConnectFailed"; readonly cause: string }
  | { readonly _tag: "IdentityUnavailable"; readonly reason: string };

export type SessionClientDisconnectError = {
  readonly _tag: "DisconnectFailed";
  readonly cause: string;
};

/**
 * Decode the role-specific `MOLTZAP_*` environment for the current AO session.
 * `serverUrl` is the base client URL, not the `/ws` transport suffix.
 */
export function loadSessionClientEnv(
  env: Record<string, string | undefined>,
  role: SessionRole,
): Result<SessionClientEnv, SessionClientConfigError> {
  const serverUrl = normalizeEnvVar(env.MOLTZAP_SERVER_URL);
  if (serverUrl === null) {
    return err({ _tag: "MissingServerUrl" });
  }
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  if (normalizedServerUrl === null) {
    return err({ _tag: "InvalidServerUrl", value: serverUrl });
  }
  const apiKey = normalizeEnvVar(env.MOLTZAP_API_KEY);
  if (apiKey === null) {
    return err({ _tag: "MissingApiKey" });
  }
  const localSenderId = normalizeEnvVar(env.MOLTZAP_LOCAL_SENDER_ID);
  if (localSenderId === null) {
    return err({ _tag: "MissingLocalSenderId" });
  }
  const orchestratorSenderId = normalizeEnvVar(env.MOLTZAP_ORCHESTRATOR_SENDER_ID);
  if (role === "worker" && orchestratorSenderId === null) {
    return err({ _tag: "MissingOrchestratorSenderId", role: "worker" });
  }
  return ok({
    role,
    serverUrl: normalizedServerUrl,
    apiKey,
    localSenderId: asMoltzapSenderId(localSenderId),
    orchestratorSenderId:
      orchestratorSenderId === null ? null : asMoltzapSenderId(orchestratorSenderId),
    allowlistCsv: normalizeCsv(env.MOLTZAP_ALLOWED_SENDERS),
  });
}

/**
 * Connect an authenticated MoltZap client for the current AO session.
 */
export async function connectSessionClient(
  env: SessionClientEnv,
  connector: SessionClientConnector,
): Promise<Result<SessionClientHandle, SessionClientConnectError>> {
  const connected = await connector.connect(env);
  if (connected._tag === "Err") {
    return err(connected.error);
  }
  if (env.localSenderId.trim().length === 0) {
    return err({
      _tag: "IdentityUnavailable",
      reason: "local sender identity is empty after config decode",
    });
  }
  if (env.role === "worker" && env.orchestratorSenderId === null) {
    return err({
      _tag: "IdentityUnavailable",
      reason: "worker session is missing orchestrator sender identity",
    });
  }
  return ok({
    role: env.role,
    normalizedServerUrl: env.serverUrl,
    sdk: connected.value,
    localSenderId: env.localSenderId,
    orchestratorSenderId: env.orchestratorSenderId,
    close: () => connector.disconnect(connected.value),
  });
}

function normalizeEnvVar(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCsv(raw: string | undefined): string | null {
  const value = normalizeEnvVar(raw);
  if (value === null) return null;
  const normalized = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(",");
  return normalized.length > 0 ? normalized : null;
}

function normalizeServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
      return null;
    }
    if (url.pathname === "/ws" || url.pathname === "/ws/") {
      url.pathname = "/";
    } else if (url.pathname.endsWith("/ws")) {
      url.pathname = url.pathname.slice(0, -3) || "/";
    }
    const normalizedPath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${normalizedPath}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
