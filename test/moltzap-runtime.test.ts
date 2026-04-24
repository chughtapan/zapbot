import { describe, expect, it } from "vitest";
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

describe("moltzap/runtime — loadMoltzapRuntimeConfig (spec rev 2)", () => {
  it("returns MoltzapDisabled when no env is set", () => {
    const result = loadMoltzapRuntimeConfig({});
    expect(result).toEqual({
      _tag: "Ok",
      value: { _tag: "MoltzapDisabled" },
    });
  });

  it("returns MoltzapRegistration when server+secret are set", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.test/ws",
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "secret-xyz",
    });
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        _tag: "MoltzapRegistration",
        serverUrl: "wss://moltzap.test/ws",
        registrationSecret: "secret-xyz",
      },
    });
  });

  it("rejects legacy MoltzapStatic env (Non-goal 4)", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.test/ws",
      ZAPBOT_MOLTZAP_API_KEY: "static-key-xyz",
    });
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error).toMatchObject({
        _tag: "MoltzapConfigInvalid",
      });
    }
  });

  it("rejects config missing registration secret", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_SERVER_URL: "wss://moltzap.test/ws",
    });
    expect(result._tag).toBe("Err");
  });

  it("rejects secret without server-url", () => {
    const result = loadMoltzapRuntimeConfig({
      ZAPBOT_MOLTZAP_REGISTRATION_SECRET: "secret-xyz",
    });
    expect(result._tag).toBe("Err");
  });
});

describe("moltzap/runtime — buildMoltzapProcessEnv (bridge-only)", () => {
  it("returns {} for MoltzapDisabled", () => {
    expect(buildMoltzapProcessEnv({ _tag: "MoltzapDisabled" })).toEqual({});
  });

  it("forwards the registration secret for MoltzapRegistration (bridge path)", () => {
    const env = buildMoltzapProcessEnv({
      _tag: "MoltzapRegistration",
      serverUrl: "wss://host/ws",
      registrationSecret: "secret",
    });
    expect(env).toEqual({
      MOLTZAP_SERVER_URL: "wss://host/ws",
      MOLTZAP_REGISTRATION_SECRET: "secret",
    });
  });

  it("never exposes an allowlist env (spec §5: server-enforced now)", () => {
    const env = buildMoltzapProcessEnv({
      _tag: "MoltzapRegistration",
      serverUrl: "wss://host/ws",
      registrationSecret: "secret",
    });
    expect(env).not.toHaveProperty("MOLTZAP_ALLOWED_SENDERS");
  });
});

describe("moltzap/runtime — buildMoltzapSpawnEnv (Invariant 4)", () => {
  const ctx = {
    repo: asRepoFullName("acme/app"),
    issue: asIssueNumber(42),
    projectName: asProjectName("app"),
    session: asAoSessionName("app-42"),
  };

  it("returns {} for MoltzapDisabled", async () => {
    const result = await buildMoltzapSpawnEnv({ _tag: "MoltzapDisabled" }, ctx);
    expect(result._tag).toBe("Ok");
    if (result._tag === "Ok") {
      expect(result.value).toEqual({});
    }
  });

  it("surfaces a tagged provisioning error when registration HTTP fails", async () => {
    const config: MoltzapRuntimeConfig = {
      _tag: "MoltzapRegistration",
      serverUrl: "http://127.0.0.1:1", // unreachable
      registrationSecret: "secret",
    };
    const result = await buildMoltzapSpawnEnv(config, ctx);
    expect(result._tag).toBe("Err");
    if (result._tag === "Err") {
      expect(result.error._tag).toBe("MoltzapProvisionFailed");
    }
  });
});
