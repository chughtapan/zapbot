import { describe, expect, it } from "vitest";
import { loadSessionClientEnv } from "../src/moltzap/session-client.ts";

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
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("InvalidServerUrl");
  });

  it("loads a worker session env with orchestrator sender id", () => {
    const result = loadSessionClientEnv(
      {
        MOLTZAP_SERVER_URL: "wss://mz.example.com",
        MOLTZAP_API_KEY: "worker-key",
        MOLTZAP_LOCAL_SENDER_ID: "worker-1",
        MOLTZAP_ORCHESTRATOR_SENDER_ID: "orch-1",
      },
      "worker",
    );
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.orchestratorSenderId).toBe("orch-1");
    expect(result.value.serverUrl).toBe("wss://mz.example.com");
  });

  it("flags missing server URL", () => {
    const result = loadSessionClientEnv(
      { MOLTZAP_API_KEY: "k", MOLTZAP_LOCAL_SENDER_ID: "s" },
      "orchestrator",
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MissingServerUrl");
  });

  it("flags missing api key", () => {
    const result = loadSessionClientEnv(
      {
        MOLTZAP_SERVER_URL: "ws://localhost:1",
        MOLTZAP_LOCAL_SENDER_ID: "s",
      },
      "orchestrator",
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MissingApiKey");
  });

  it("flags missing local sender id", () => {
    const result = loadSessionClientEnv(
      {
        MOLTZAP_SERVER_URL: "ws://localhost:1",
        MOLTZAP_API_KEY: "k",
      },
      "orchestrator",
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MissingLocalSenderId");
  });
});
