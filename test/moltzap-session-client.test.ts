import { describe, expect, it } from "vitest";
import {
  connectSessionClient,
  loadSessionClientEnv,
  type SessionClientConnector,
  type SessionClientEnv,
} from "../src/moltzap/session-client.ts";
import { err, ok } from "../src/types.ts";
import type { MoltzapSdkHandle } from "../src/moltzap/types.ts";

const fakeSdk = { __brand: "MoltzapSdkHandle" } as MoltzapSdkHandle;

describe("loadSessionClientEnv", () => {
  it("normalizes the ws transport suffix and loads an orchestrator session env", () => {
    const result = loadSessionClientEnv(
      {
        MOLTZAP_SERVER_URL: "ws://127.0.0.1:41973/ws",
        MOLTZAP_API_KEY: "test-key",
        MOLTZAP_LOCAL_SENDER_ID: "agent-orchestrator",
        MOLTZAP_ALLOWED_SENDERS: "agent-a, agent-b ",
      },
      "orchestrator",
    );
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        role: "orchestrator",
        serverUrl: "ws://127.0.0.1:41973",
        apiKey: "test-key",
        localSenderId: "agent-orchestrator",
        orchestratorSenderId: null,
        allowlistCsv: "agent-a,agent-b",
      },
    });
  });

  it("requires the orchestrator sender id for worker sessions", () => {
    const result = loadSessionClientEnv(
      {
        MOLTZAP_SERVER_URL: "ws://127.0.0.1:41973/ws",
        MOLTZAP_API_KEY: "test-key",
        MOLTZAP_LOCAL_SENDER_ID: "worker-1",
      },
      "worker",
    );
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "MissingOrchestratorSenderId", role: "worker" },
    });
  });

  it("rejects malformed URLs", () => {
    const result = loadSessionClientEnv(
      {
        MOLTZAP_SERVER_URL: "mailto:not-supported",
        MOLTZAP_API_KEY: "test-key",
        MOLTZAP_LOCAL_SENDER_ID: "worker-1",
        MOLTZAP_ORCHESTRATOR_SENDER_ID: "orch-1",
      },
      "worker",
    );
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "InvalidServerUrl", value: "mailto:not-supported" },
    });
  });
});

describe("connectSessionClient", () => {
  const env: SessionClientEnv = {
    role: "worker",
    serverUrl: "ws://127.0.0.1:41973",
    apiKey: "test-key",
    localSenderId: "worker-1" as never,
    orchestratorSenderId: "orch-1" as never,
    allowlistCsv: null,
  };

  it("wraps the connector result in a session handle", async () => {
    let disconnected = false;
    const connector: SessionClientConnector = {
      connect: async () => ok(fakeSdk),
      disconnect: async () => {
        disconnected = true;
        return ok(undefined);
      },
    };
    const result = await connectSessionClient(env, connector);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.normalizedServerUrl).toBe("ws://127.0.0.1:41973");
    const closed = await result.value.close();
    expect(closed).toEqual({ _tag: "Ok", value: undefined });
    expect(disconnected).toBe(true);
  });

  it("surfaces connector failures as typed errors", async () => {
    const connector: SessionClientConnector = {
      connect: async () => err({ _tag: "ConnectFailed", cause: "socket closed" }),
      disconnect: async () => ok(undefined),
    };
    const result = await connectSessionClient(env, connector);
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "ConnectFailed", cause: "socket closed" },
    });
  });
});
