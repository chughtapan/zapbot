/**
 * Tests for src/moltzap/bridge-identity.ts.
 *
 * Anchors: sbd#199 acceptance item 7 (bridge identity per A+C(2));
 * replacement for the literal-string fallback at src/bridge.ts:801-803.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asBridgeAgentId,
  bridgeAgentIdAsSenderId,
  loadBridgeIdentityEnv,
  normalizeServerUrl,
  registerBridgeAgent,
} from "../src/moltzap/bridge-identity.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bridge-identity: env decode", () => {
  it("returns BridgeIdentityMissingSecret when ZAPBOT_MOLTZAP_REGISTRATION_SECRET is unset", () => {
    const result = loadBridgeIdentityEnv({});
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BridgeIdentityMissingSecret");
  });

  it("returns BridgeIdentityMissingSecret when secret is whitespace-only", () => {
    const result = loadBridgeIdentityEnv({
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "   ",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BridgeIdentityMissingSecret");
  });

  it("defaults displayName to 'zapbot-bridge' when env var is unset", () => {
    const result = loadBridgeIdentityEnv({
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "reg-secret",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.displayName).toBe("zapbot-bridge");
    expect(result.value.registrationSecret).toBe("reg-secret");
  });

  it("uses ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME when provided", () => {
    const result = loadBridgeIdentityEnv({
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "reg-secret",
      ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME: "custom-bridge",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.displayName).toBe("custom-bridge");
  });

  it("returns BridgeIdentityInvalidEnv when displayName exceeds 128 chars", () => {
    const result = loadBridgeIdentityEnv({
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "reg-secret",
      ZAPBOT_MOLTZAP_BRIDGE_AGENT_NAME: "x".repeat(129),
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BridgeIdentityInvalidEnv");
  });
});

describe("bridge-identity: registerBridgeAgent", () => {
  it("posts to /api/v1/auth/register with the registration secret", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ agentId: "bridge-123", apiKey: "key-abc" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await registerBridgeAgent(
      {
        serverUrl: "https://moltzap.example",
        registrationSecret: "reg-secret",
        displayName: "zapbot-bridge",
      },
      fetchSpy,
    );
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.agentId).toBe("bridge-123");
    expect(result.value.agentKey).toBe("key-abc");
    expect(result.value.displayName).toBe("zapbot-bridge");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://moltzap.example/api/v1/auth/register");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body) as {
      name: string;
      inviteCode: string;
    };
    expect(body.name).toBe("zapbot-bridge");
    expect(body.inviteCode).toBe("reg-secret");
  });

  it("returns BridgeRegistrationHttpFailed on non-2xx response", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    const result = await registerBridgeAgent(
      {
        serverUrl: "https://moltzap.example",
        registrationSecret: "bad",
        displayName: "zb",
      },
      fetchSpy,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BridgeRegistrationHttpFailed");
    if (result.error._tag !== "BridgeRegistrationHttpFailed") return;
    expect(result.error.status).toBe(403);
    expect(result.error.body).toBe("forbidden");
  });

  it("returns BridgeRegistrationDecodeFailed on malformed JSON body", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response("<not-json>", { status: 201 }));
    const result = await registerBridgeAgent(
      {
        serverUrl: "https://moltzap.example",
        registrationSecret: "s",
        displayName: "zb",
      },
      fetchSpy,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BridgeRegistrationDecodeFailed");
  });

  it("returns BridgeRegistrationDecodeFailed when response is missing agentId/apiKey", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ onlyApiKey: "abc" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await registerBridgeAgent(
      {
        serverUrl: "https://moltzap.example",
        registrationSecret: "s",
        displayName: "zb",
      },
      fetchSpy,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BridgeRegistrationDecodeFailed");
  });

  it("wraps transport errors as BridgeRegistrationHttpFailed status=0", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await registerBridgeAgent(
      {
        serverUrl: "https://moltzap.example",
        registrationSecret: "s",
        displayName: "zb",
      },
      fetchSpy,
    );
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("BridgeRegistrationHttpFailed");
    if (result.error._tag !== "BridgeRegistrationHttpFailed") return;
    expect(result.error.status).toBe(0);
    expect(result.error.body).toContain("ECONNREFUSED");
  });
});

describe("bridge-identity: branded type", () => {
  it("asBridgeAgentId + bridgeAgentIdAsSenderId widen nominally", () => {
    const id = asBridgeAgentId("bridge-xyz");
    const sender = bridgeAgentIdAsSenderId(id);
    // Both projections share the same underlying string.
    expect(sender as unknown as string).toBe("bridge-xyz");
  });
});

describe("bridge-identity: normalizeServerUrl (Fix 3 — sbd#204)", () => {
  // The vendor ws-client appends "/ws" unconditionally. A URL already ending
  // in "/ws" produces "/ws/ws". Both forms must normalize to the same base.

  it("bare ws URL is unchanged", () => {
    expect(normalizeServerUrl("ws://host:3000")).toBe("ws://host:3000");
  });

  it("URL with trailing /ws is stripped to bare URL", () => {
    expect(normalizeServerUrl("ws://host:3000/ws")).toBe("ws://host:3000");
  });

  it("URL with trailing /ws/ (slash after ws) is stripped to bare URL", () => {
    expect(normalizeServerUrl("ws://host:3000/ws/")).toBe("ws://host:3000");
  });

  it("URL with trailing / is stripped", () => {
    expect(normalizeServerUrl("ws://host:3000/")).toBe("ws://host:3000");
  });

  it("http and https schemes are also normalized", () => {
    expect(normalizeServerUrl("https://host:3000/ws")).toBe("https://host:3000");
    expect(normalizeServerUrl("http://host:3000/")).toBe("http://host:3000");
  });

  it("both ws://host:port and ws://host:port/ws produce the same normalized URL", () => {
    const base = normalizeServerUrl("ws://host:3000");
    const withWs = normalizeServerUrl("ws://host:3000/ws");
    expect(base).toBe(withWs);
  });
});
