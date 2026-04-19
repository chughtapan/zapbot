/**
 * v2/moltzap/session-client — load `MOLTZAP_*` env inside an AO session and
 * connect an authenticated MoltZap client.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import type { MoltzapSdkHandle, MoltzapSenderId } from "./types.ts";

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
  throw new Error("not implemented");
}

/**
 * Connect an authenticated MoltZap client for the current AO session.
 */
export async function connectSessionClient(
  env: SessionClientEnv,
  connector: SessionClientConnector,
): Promise<Result<SessionClientHandle, SessionClientConnectError>> {
  throw new Error("not implemented");
}
