/**
 * Tests for src/moltzap/worker-channel.ts.
 *
 * Anchors: sbd#199 acceptance items 1, 7 (worker boot via channel-plugin),
 * 8 (zapbot#336 — workers never register or create sessions). Operator
 * correction
 * (https://github.com/chughtapan/safer-by-default/issues/199#issuecomment-4316798423):
 * workers are channel-plugin peers, not MoltZapApp consumers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkerChannelEnv } from "../src/moltzap/worker-channel.ts";

describe("worker-channel: env decode", () => {
  it("loadWorkerChannelEnv requires MOLTZAP_SERVER_URL", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_AGENT_KEY: "key",
      AO_CALLER_TYPE: "architect",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("WorkerChannelMissingServerUrl");
  });

  it("loadWorkerChannelEnv requires MOLTZAP_AGENT_KEY (or legacy MOLTZAP_API_KEY)", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      AO_CALLER_TYPE: "architect",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("WorkerChannelMissingAgentKey");
  });

  it("loadWorkerChannelEnv accepts legacy MOLTZAP_API_KEY when MOLTZAP_AGENT_KEY is unset", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_API_KEY: "legacy-key",
      AO_CALLER_TYPE: "architect",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.agentKey).toBe("legacy-key");
  });

  it("loadWorkerChannelEnv decodes AO_CALLER_TYPE into a 4-value SessionRole", () => {
    for (const role of ["architect", "implementer", "reviewer", "orchestrator"]) {
      const result = loadWorkerChannelEnv({
        MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
        MOLTZAP_AGENT_KEY: "key",
        AO_CALLER_TYPE: role,
      });
      expect(result._tag).toBe("Ok");
      if (result._tag !== "Ok") return;
      expect(result.value.role).toBe(role);
    }
  });

  it("loadWorkerChannelEnv rejects unknown role strings with WorkerChannelInvalidRole", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_AGENT_KEY: "key",
      AO_CALLER_TYPE: "lemur",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("WorkerChannelInvalidRole");
    if (result.error._tag !== "WorkerChannelInvalidRole") return;
    expect(result.error.raw).toBe("lemur");
  });

  it("loadWorkerChannelEnv carries MOLTZAP_BRIDGE_AGENT_ID when present", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_AGENT_KEY: "key",
      AO_CALLER_TYPE: "architect",
      MOLTZAP_BRIDGE_AGENT_ID: "bridge-abc",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.bridgeAgentId).toBe("bridge-abc");
  });

  it("loadWorkerChannelEnv yields null bridgeAgentId when MOLTZAP_BRIDGE_AGENT_ID is unset", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_AGENT_KEY: "key",
      AO_CALLER_TYPE: "architect",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.bridgeAgentId).toBeNull();
  });
});

describe("worker-channel: zapbot#336 — workers never register or create (grep-time)", () => {
  it("worker-channel.ts does not import @moltzap/app-sdk", () => {
    const text = readFileSync(
      join(__dirname, "..", "src", "moltzap", "worker-channel.ts"),
      "utf8",
    );
    // Match actual ES import statements, not JSDoc prose.
    expect(
      /^import[\s\S]*?from\s*["']@moltzap\/app-sdk["']/m.test(text),
    ).toBe(false);
  });

  it("bin/moltzap-claude-channel.ts does not import @moltzap/app-sdk", () => {
    const text = readFileSync(
      join(__dirname, "..", "bin", "moltzap-claude-channel.ts"),
      "utf8",
    );
    expect(
      /^import[\s\S]*?from\s*["']@moltzap\/app-sdk["']/m.test(text),
    ).toBe(false);
  });
});
