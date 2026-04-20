import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMoltzapProcessEnv,
  buildMoltzapSpawnEnv,
  loadMoltzapRuntimeConfig,
  type MoltzapRuntimeConfig,
} from "../src/moltzap/runtime.ts";
import {
  asAoSessionName,
  asIssueNumber,
  asProjectName,
  asRepoFullName,
} from "../src/types.ts";
import { gateInbound } from "../src/moltzap/identity-allowlist.ts";
import {
  asMoltzapConversationId,
  asMoltzapMessageId,
  asMoltzapSenderId,
} from "../src/moltzap/types.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const spawnContext = {
  repo: asRepoFullName("acme/app"),
  issue: asIssueNumber(42),
  projectName: asProjectName("app"),
  session: asAoSessionName("app-42"),
} as const;

describe("moltzap runtime / loadMoltzapRuntimeConfig", () => {
  it("returns MoltzapDisabled when no MoltZap env is configured", () => {
    const result = loadMoltzapRuntimeConfig({});
    expect(result).toEqual({ _tag: "Ok", value: { _tag: "MoltzapDisabled" } });
  });

  it("rejects auth config without a server URL", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_API_KEY: "mz-key",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error.reason).toContain("ZAPBOT_MOLTZAP_SERVER_URL");
  });

  it("loads static API-key mode", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      ZAPBOT_MOLTZAP_API_KEY: "mz-key",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value).toMatchObject({
      _tag: "MoltzapStatic",
      serverUrl: "wss://moltzap.example/ws",
      apiKey: "mz-key",
      allowlistCsv: null,
    });
  });

  it("loads registration mode and builds a sender allowlist from CSV", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "reg-secret",
      ZAPBOT_MOLTZAP_ALLOWED_SENDERS: "agent-a, agent-b ",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value._tag).toBe("MoltzapRegistration");
    if (result.value._tag !== "MoltzapRegistration") return;
    expect(result.value.allowlistCsv).toBe("agent-a,agent-b");
    const gate = gateInbound(result.value.allowlist, {
      messageId: asMoltzapMessageId("m-1"),
      conversationId: asMoltzapConversationId("conv-1"),
      senderId: asMoltzapSenderId("agent-b"),
      bodyText: "hello",
      receivedAtMs: 1,
    });
    expect(gate._tag).toBe("Ok");
  });
});

describe("moltzap runtime / buildMoltzapSpawnEnv", () => {
  it("returns an empty env map when MoltZap is disabled", async () => {
    const result = await buildMoltzapSpawnEnv({ _tag: "MoltzapDisabled" }, spawnContext);
    expect(result).toEqual({ _tag: "Ok", value: {} });
  });

  it("returns static MOLTZAP_* env when using a pre-provisioned API key", async () => {
    const config: MoltzapRuntimeConfig = {
      _tag: "MoltzapStatic",
      serverUrl: "wss://moltzap.example/ws",
      apiKey: "mz-key",
      allowlistCsv: "agent-a,agent-b",
      allowlist: loadMoltzapRuntimeConfig({
        ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
        ZAPBOT_MOLTZAP_API_KEY: "mz-key",
        ZAPBOT_MOLTZAP_ALLOWED_SENDERS: "agent-a,agent-b",
      })._tag === "Ok"
        ? (loadMoltzapRuntimeConfig({
            ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
            ZAPBOT_MOLTZAP_API_KEY: "mz-key",
            ZAPBOT_MOLTZAP_ALLOWED_SENDERS: "agent-a,agent-b",
          }) as Extract<
            ReturnType<typeof loadMoltzapRuntimeConfig>,
            { readonly _tag: "Ok" }
          >).value.allowlist
        : (() => {
            throw new Error("unreachable");
          })(),
    };
    const result = await buildMoltzapSpawnEnv(config, spawnContext);
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
        MOLTZAP_API_KEY: "mz-key",
        MOLTZAP_ALLOWED_SENDERS: "agent-a,agent-b",
      },
    });
  });

  it("registers a fresh agent when a registration secret is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ apiKey: "registered-key", agentId: "agent-123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const configResult = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "reg-secret",
      ZAPBOT_MOLTZAP_ALLOWED_SENDERS: "agent-a",
    });
    expect(configResult._tag).toBe("Ok");
    if (configResult._tag !== "Ok" || configResult.value._tag !== "MoltzapRegistration") return;

    const result = await buildMoltzapSpawnEnv(configResult.value, spawnContext);
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
        MOLTZAP_API_KEY: "registered-key",
        MOLTZAP_LOCAL_SENDER_ID: "agent-123",
        MOLTZAP_ALLOWED_SENDERS: "agent-a",
      },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://moltzap.example/ws/api/v1/auth/register");
    expect(init?.method).toBe("POST");
    const parsedBody = JSON.parse(String(init?.body)) as {
      name: string;
      description: string;
      inviteCode: string;
    };
    expect(parsedBody.inviteCode).toBe("reg-secret");
    expect(parsedBody.description).toContain("app-42");
    expect(parsedBody.name).toMatch(/^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$/);
  });

  it("returns MoltzapProvisionFailed when registration fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));
    const configResult = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "reg-secret",
    });
    expect(configResult._tag).toBe("Ok");
    if (configResult._tag !== "Ok" || configResult.value._tag !== "MoltzapRegistration") return;

    const result = await buildMoltzapSpawnEnv(configResult.value, spawnContext);
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error._tag).toBe("MoltzapProvisionFailed");
    expect(result.error.cause).toContain("403");
  });
});

describe("moltzap runtime / buildMoltzapProcessEnv", () => {
  it("returns an empty env map when MoltZap is disabled", () => {
    expect(buildMoltzapProcessEnv({ _tag: "MoltzapDisabled" })).toEqual({});
  });

  it("maps static config into parent-process env for ao sessions", () => {
    expect(
      buildMoltzapProcessEnv({
        _tag: "MoltzapStatic",
        serverUrl: "wss://moltzap.example/ws",
        apiKey: "mz-key",
        allowlistCsv: "orch-1,worker-1",
        allowlist: loadMoltzapRuntimeConfig({
          ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
          ZAPBOT_MOLTZAP_API_KEY: "mz-key",
          ZAPBOT_MOLTZAP_ALLOWED_SENDERS: "orch-1,worker-1",
        })._tag === "Ok"
          ? (loadMoltzapRuntimeConfig({
              ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
              ZAPBOT_MOLTZAP_API_KEY: "mz-key",
              ZAPBOT_MOLTZAP_ALLOWED_SENDERS: "orch-1,worker-1",
            }) as Extract<
              ReturnType<typeof loadMoltzapRuntimeConfig>,
              { readonly _tag: "Ok" }
            >).value.allowlist
          : (() => {
              throw new Error("unreachable");
            })(),
      }),
    ).toEqual({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_API_KEY: "mz-key",
      MOLTZAP_ALLOWED_SENDERS: "orch-1,worker-1",
    });
  });

  it("maps registration config into parent-process env for ao sessions", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "reg-secret",
      ZAPBOT_MOLTZAP_ALLOWED_SENDERS: "orch-1",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok" || result.value._tag !== "MoltzapRegistration") return;
    expect(buildMoltzapProcessEnv(result.value)).toEqual({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_REGISTRATION_SECRET: "reg-secret",
      MOLTZAP_ALLOWED_SENDERS: "orch-1",
    });
  });
});
