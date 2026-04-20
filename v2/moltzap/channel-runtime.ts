/**
 * v2/moltzap/channel-runtime — bind a connected session client to the existing
 * lifecycle, listener, and bridge modules.
 *
 * Architect phase only: public surface, no implementation.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type {
  DiagnosticSink,
  MoltzapSender,
  ReplyArgs,
  ReplyReceipt,
} from "./bridge.ts";
import { reply } from "./bridge.ts";
import type { LifecycleState, ListenerRegistrationError } from "./lifecycle.ts";
import { INITIAL, transition } from "./lifecycle.ts";
import type { DecodeErrorSink, MoltzapRegistrar } from "./listener.ts";
import { register } from "./listener.ts";
import type { SessionClientHandle } from "./session-client.ts";
import type {
  ListenerHandle,
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
  let currentState: LifecycleState = INITIAL;
  const advancedToStdio = advance(currentState, { _tag: "StdioConnectStarted" });
  if (advancedToStdio._tag === "Err") {
    return advancedToStdio;
  }
  currentState = advancedToStdio.value;
  const stdioReady = advance(currentState, { _tag: "StdioConnected" });
  if (stdioReady._tag === "Err") {
    return stdioReady;
  }
  currentState = stdioReady.value;
  const moltzapConnecting = advance(currentState, { _tag: "MoltzapConnectStarted" });
  if (moltzapConnecting._tag === "Err") {
    return moltzapConnecting;
  }
  currentState = moltzapConnecting.value;
  const moltzapReady = advance(currentState, { _tag: "MoltzapReady" });
  if (moltzapReady._tag === "Err") {
    return moltzapReady;
  }
  currentState = moltzapReady.value;

  const listener = await register(
    currentState,
    client.sdk,
    (event) => {
      void routeInbound(event);
    },
    deps.registrar,
    deps.decodeDiag,
  );
  if (listener._tag === "Err") {
    const failedState = advance(currentState, {
      _tag: "ListenerFailed",
      cause: listener.error,
    });
    if (failedState._tag === "Ok") {
      currentState = failedState.value;
    }
    return err({ _tag: "ListenerRejected", cause: listener.error });
  }

  const listening = advance(currentState, {
    _tag: "ListenerRegistered",
    handle: listener.value,
  });
  if (listening._tag === "Err") {
    return listening;
  }
  currentState = listening.value;

  async function routeInbound(
    event: MoltzapInbound,
  ): Promise<void> {
    try {
      const result = await deps.onInbound(event);
      if (result._tag === "Err") {
        currentState = {
          _tag: "FAILED",
          cause: {
            _tag: "TransportConnectError",
            cause: result.error.cause,
          },
        };
      }
    } catch (cause) {
      currentState = {
        _tag: "FAILED",
        cause: {
          _tag: "TransportConnectError",
          cause: stringifyCause(cause),
        },
      };
    }
  }

  return ok({
    role: client.role,
    localSenderId: client.localSenderId,
    get state() {
      return currentState;
    },
    stop: async () => {
      const draining = transition(currentState, {
        _tag: "DrainRequested",
        reason: { _tag: "SigTerm" },
      });
      if (draining._tag === "Next") {
        currentState = draining.state;
      }
      const closed = await client.close();
      if (closed._tag === "Err") {
        return err({ _tag: "StopFailed", cause: closed.error.cause });
      }
      const stopped = transition(currentState, { _tag: "Stopped" });
      if (stopped._tag === "Illegal") {
        currentState = { _tag: "STOPPED" };
      } else {
        currentState = stopped.state;
      }
      return ok(undefined);
    },
    send: async (args) => {
      const result = await reply(
        currentState,
        args,
        deps.sdkContext,
        deps.sender,
        deps.now,
      );
      if (result._tag === "Err") {
        switch (result.error._tag) {
          case "NotListening":
            return err({
              _tag: "NotListening",
              state: result.error.state,
            });
          case "OutboundFailed":
            return err({
              _tag: "OutboundFailed",
              cause: stringifyCause(result.error.cause),
            });
          case "PreReadyEventDropped":
            return err({
              _tag: "OutboundFailed",
              cause: "outbound send attempted before runtime reached LISTENING",
            });
          default:
            return absurd(result.error);
        }
      }
      return ok(result.value);
    },
  });
}

function advance(
  state: LifecycleState,
  event:
    | { readonly _tag: "StdioConnectStarted" }
    | { readonly _tag: "StdioConnected" }
    | { readonly _tag: "MoltzapConnectStarted" }
    | { readonly _tag: "MoltzapReady" }
    | { readonly _tag: "ListenerRegistered"; readonly handle: ListenerHandle }
    | { readonly _tag: "ListenerFailed"; readonly cause: ListenerRegistrationError },
): Result<LifecycleState, Extract<ChannelRuntimeStartError, { readonly _tag: "LifecycleFailed" }>> {
  const next = transition(state, event);
  if (next._tag === "Illegal") {
    return err({
      _tag: "LifecycleFailed",
      reason: `illegal lifecycle transition ${state._tag} -> ${event._tag}`,
    });
  }
  return ok(next.state);
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
