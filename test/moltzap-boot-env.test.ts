import { describe, expect, it } from "vitest";
import { resolveChannelBootstrap } from "../src/moltzap/boot-env.ts";

/**
 * Focused tests for the static-mode correctness path in
 * `resolveChannelBootstrap`. Reviewer-187 called out a regression where the
 * static branch silently wrote an empty `localSenderId` when
 * `MOLTZAP_LOCAL_SENDER_ID` was not set — breaking downstream peer allowlist
 * matching for any non-Registration deployment. The fix requires the env var
 * in static mode and fails loudly instead.
 *
 * The Registration path is intentionally NOT exercised here; it makes a real
 * HTTP call to /api/v1/auth/register and belongs in an integration suite.
 */
describe("resolveChannelBootstrap — static mode (MOLTZAP_API_KEY)", () => {
  it("returns Ok when both MOLTZAP_API_KEY and MOLTZAP_LOCAL_SENDER_ID are set", async () => {
    const result = await resolveChannelBootstrap({
      MOLTZAP_SERVER_URL: "wss://moltzap.example/ws",
      MOLTZAP_API_KEY: "mz_static_abc",
      MOLTZAP_LOCAL_SENDER_ID: "agent-zapbot-1",
    });
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value.apiKey).toBe("mz_static_abc");
    expect(result.value.localSenderId).toBe("agent-zapbot-1");
    // `/ws` suffix is normalized off the base URL.
    expect(result.value.serverUrl).toBe("wss://moltzap.example");
  });

  it("returns Err when MOLTZAP_API_KEY is set but MOLTZAP_LOCAL_SENDER_ID is absent (reviewer-187)", async () => {
    const result = await resolveChannelBootstrap({
      MOLTZAP_SERVER_URL: "wss://moltzap.example",
      MOLTZAP_API_KEY: "mz_static_abc",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error).toMatch(/MOLTZAP_LOCAL_SENDER_ID is required/);
  });

  it("returns Err when MOLTZAP_LOCAL_SENDER_ID is present but blank", async () => {
    const result = await resolveChannelBootstrap({
      MOLTZAP_SERVER_URL: "wss://moltzap.example",
      MOLTZAP_API_KEY: "mz_static_abc",
      MOLTZAP_LOCAL_SENDER_ID: "   ",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error).toMatch(/MOLTZAP_LOCAL_SENDER_ID is required/);
  });

  it("returns Err when MOLTZAP_SERVER_URL is absent", async () => {
    const result = await resolveChannelBootstrap({
      MOLTZAP_API_KEY: "mz_static_abc",
      MOLTZAP_LOCAL_SENDER_ID: "agent-zapbot-1",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error).toMatch(/MOLTZAP_SERVER_URL/);
  });

  it("returns Err when neither API key nor registration secret is set", async () => {
    const result = await resolveChannelBootstrap({
      MOLTZAP_SERVER_URL: "wss://moltzap.example",
    });
    expect(result._tag).toBe("Err");
    if (result._tag !== "Err") return;
    expect(result.error).toMatch(
      /either MOLTZAP_API_KEY or MOLTZAP_REGISTRATION_SECRET/,
    );
  });
});
