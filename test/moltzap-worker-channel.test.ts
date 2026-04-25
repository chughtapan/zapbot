/**
 * Tests for src/moltzap/worker-channel.ts.
 *
 * Anchors: sbd#199 acceptance items 1, 7 (worker boot via channel-plugin),
 * 8 (zapbot#336 — workers never register or create sessions). Operator
 * correction
 * (https://github.com/chughtapan/safer-by-default/issues/199#issuecomment-4316798423):
 * workers are channel-plugin peers, not MoltZapApp consumers.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatWorkerCredentialsError,
  loadWorkerChannelEnv,
  resolveWorkerCredentials,
  writeWorkerMetadata,
} from "../src/moltzap/worker-channel.ts";

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

  it("loadWorkerChannelEnv maps legacy AO_CALLER_TYPE='agent' to implementer (resume-path compat)", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_AGENT_KEY: "key",
      AO_CALLER_TYPE: "agent",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.role).toBe("implementer");
  });

  it("loadWorkerChannelEnv honors MOLTZAP_WORKER_ROLE over AO_CALLER_TYPE", () => {
    const result = loadWorkerChannelEnv({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_AGENT_KEY: "key",
      AO_CALLER_TYPE: "agent",
      MOLTZAP_WORKER_ROLE: "reviewer",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.role).toBe("reviewer");
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

// sbd#202: bin glue helpers relocated from `bin/moltzap-claude-channel.ts`.
// The bin keeps env decode + bootWorkerChannel + signal handlers; these
// helpers carry the credential resolution + AO resume metadata write.
// The transitional self-register path (path 2) is kept until sbd#205
// removes worker self-register end-to-end.
describe("worker-channel: resolveWorkerCredentials", () => {
  it("path 1 — uses pre-minted MOLTZAP_AGENT_KEY + MOLTZAP_LOCAL_SENDER_ID directly", async () => {
    const result = await resolveWorkerCredentials({
      MOLTZAP_AGENT_KEY: "key-from-bridge",
      MOLTZAP_LOCAL_SENDER_ID: "sender-123",
      // Server URL + registration secret would normally trigger path 2,
      // but path 1 wins when both pre-minted creds are present.
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_REGISTRATION_SECRET: "should-not-be-used",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value).toEqual({
      agentKey: "key-from-bridge",
      senderId: "sender-123",
    });
  });

  it("path 1 — accepts legacy MOLTZAP_API_KEY as agent key", async () => {
    const result = await resolveWorkerCredentials({
      MOLTZAP_API_KEY: "legacy-key",
      MOLTZAP_LOCAL_SENDER_ID: "sender-legacy",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.agentKey).toBe("legacy-key");
  });

  it("rejects when no creds are present and no registration path is wired", async () => {
    const result = await resolveWorkerCredentials({});
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("WorkerCredentialsMissingServerUrl");
  });

  it("rejects when MOLTZAP_SERVER_URL is set but neither pre-minted creds nor registration secret is provided", async () => {
    const result = await resolveWorkerCredentials({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("WorkerCredentialsMissingSecrets");
  });
});

describe("worker-channel: formatWorkerCredentialsError", () => {
  it("formats every error tag (exhaustiveness check)", () => {
    expect(
      formatWorkerCredentialsError({ _tag: "WorkerCredentialsMissingServerUrl" }),
    ).toContain("MOLTZAP_SERVER_URL");
    expect(
      formatWorkerCredentialsError({ _tag: "WorkerCredentialsMissingSecrets" }),
    ).toContain("MOLTZAP_AGENT_KEY");
    expect(
      formatWorkerCredentialsError({
        _tag: "WorkerCredentialsRegisterFailed",
        cause: "BridgeRegistrationHttpFailed",
      }),
    ).toContain("BridgeRegistrationHttpFailed");
  });
});

describe("worker-channel: writeWorkerMetadata", () => {
  let tempDir: string;
  let sessionFile: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zapbot-worker-meta-"));
    sessionFile = join(tempDir, "session-1");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends new keys to the AO metadata file", () => {
    writeFileSync(sessionFile, "ao_pid=12345\nao_started_at=2026-04-25\n", "utf8");
    writeWorkerMetadata(
      { AO_DATA_DIR: tempDir, AO_SESSION: "session-1" },
      { agentKey: "key-abc", senderId: "sender-xyz" },
      "wss://moltzap.example/ws",
    );
    const content = readFileSync(sessionFile, "utf8");
    expect(content).toContain("moltzap_sender_id=sender-xyz");
    expect(content).toContain("moltzap_api_key=key-abc");
    expect(content).toContain("moltzap_server_url=wss://moltzap.example/ws");
    // Existing keys preserved.
    expect(content).toContain("ao_pid=12345");
  });

  it("replaces existing moltzap keys without duplicating", () => {
    writeFileSync(
      sessionFile,
      "ao_pid=12345\nmoltzap_api_key=old-key\nmoltzap_sender_id=old-sender\n",
      "utf8",
    );
    writeWorkerMetadata(
      { AO_DATA_DIR: tempDir, AO_SESSION: "session-1" },
      { agentKey: "new-key", senderId: "new-sender" },
      "wss://moltzap.example/ws",
    );
    const content = readFileSync(sessionFile, "utf8");
    const apiKeyOccurrences = content.split("\n").filter((l) => l.startsWith("moltzap_api_key=")).length;
    expect(apiKeyOccurrences).toBe(1);
    expect(content).toContain("moltzap_api_key=new-key");
    expect(content).toContain("moltzap_sender_id=new-sender");
    expect(content).not.toContain("old-key");
  });

  it("no-ops when AO_DATA_DIR is absent (ad-hoc local runs)", () => {
    // No throw, no file written.
    expect(() =>
      writeWorkerMetadata(
        { AO_SESSION: "session-1" },
        { agentKey: "k", senderId: "s" },
        "wss://moltzap.example/ws",
      ),
    ).not.toThrow();
  });

  it("no-ops when the metadata file does not exist", () => {
    // sessionFile not created — readFileSync throws inside the helper,
    // the helper catches and returns early. No write happens.
    expect(() =>
      writeWorkerMetadata(
        { AO_DATA_DIR: tempDir, AO_SESSION: "missing" },
        { agentKey: "k", senderId: "s" },
        "wss://moltzap.example/ws",
      ),
    ).not.toThrow();
  });
});
