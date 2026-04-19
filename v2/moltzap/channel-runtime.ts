/**
 * v2/moltzap/channel-runtime — bind a connected session client to the existing
 * lifecycle, listener, and bridge modules.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import type {
  DiagnosticSink,
  MoltzapSender,
  ReplyArgs,
  ReplyReceipt,
} from "./bridge.ts";
import type { LifecycleState, ListenerRegistrationError } from "./lifecycle.ts";
import type { DecodeErrorSink, MoltzapRegistrar } from "./listener.ts";
import type { SessionClientHandle } from "./session-client.ts";
import type {
  MoltzapConversationId,
  MoltzapInbound,
  MoltzapSdkContext,
  MoltzapSenderId,
} from "./types.ts";

export interface SessionChannelHandle {
  readonly role: SessionClientHandle["role"];
  readonly localSenderId: MoltzapSenderId;
  readonly state: LifecycleState;
  readonly stop: () => Promise<Result<void, ChannelRuntimeStopError>>;
  readonly send: (args: ReplyArgs) => Promise<Result<ReplyReceipt, ChannelRuntimeSendError>>;
}

export interface SessionChannelDeps {
  readonly sdkContext: MoltzapSdkContext;
  readonly registrar: MoltzapRegistrar;
  readonly sender: MoltzapSender;
  readonly onInbound: (
    event: MoltzapInbound,
  ) => Promise<Result<void, Extract<ChannelRuntimeStartError, { readonly _tag: "InboundRouteFailed" }>>>;
  readonly decodeDiag: DecodeErrorSink;
  readonly bridgeDiag: DiagnosticSink;
  readonly now?: () => number;
}

export interface DirectMessage {
  readonly peer: MoltzapSenderId;
  readonly conversationId: MoltzapConversationId | null;
  readonly text: string;
}

export type ChannelRuntimeStartError =
  | { readonly _tag: "ListenerRejected"; readonly cause: ListenerRegistrationError }
  | { readonly _tag: "LifecycleFailed"; readonly reason: string }
  | { readonly _tag: "InboundRouteFailed"; readonly cause: string };

export type ChannelRuntimeSendError =
  | { readonly _tag: "NotListening"; readonly state: LifecycleState }
  | { readonly _tag: "OutboundFailed"; readonly cause: string };

export type ChannelRuntimeStopError = {
  readonly _tag: "StopFailed";
  readonly cause: string;
};

/**
 * Start the shared MoltZap channel runtime for either an orchestrator or a
 * worker AO session.
 */
export async function bootSessionChannelRuntime(
  client: SessionClientHandle,
  deps: SessionChannelDeps,
): Promise<Result<SessionChannelHandle, ChannelRuntimeStartError>> {
  throw new Error("not implemented");
}
