import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/ao/dispatcher.ts";
import {
  asIssueNumber,
  asProjectName,
  asRepoFullName,
} from "../src/types.ts";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  vi.restoreAllMocks();
});

describe("dispatch", () => {
  it("passes MOLTZAP_* env through to spawned ao sessions", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zapbot-dispatch-"));
    const fakeAoPath = path.join(tempDir, "ao");
    const captureBase = path.join(tempDir, "ao-config.yaml");
    fs.writeFileSync(
      fakeAoPath,
      `#!/usr/bin/env sh
out="$AO_CONFIG_PATH.capture"
{
  printf '%s\\n' "$AO_PROJECT_ID"
  printf '%s\\n' "$GH_TOKEN"
  printf '%s\\n' "$MOLTZAP_SERVER_URL"
  printf '%s\\n' "$MOLTZAP_API_KEY"
} > "$out"
exit 0
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;

    // rev 4 §8.1 path A: registration-backed only. Mock the auth/register
    // endpoint so dispatch's provisioning call succeeds without a live
    // MoltZap server.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ apiKey: "moltzap-key", agentId: "agent-spawned" }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await dispatch({
      repo: asRepoFullName("acme/app"),
      issue: asIssueNumber(42),
      projectName: asProjectName("app"),
      configPath: captureBase,
      installationToken: "gh-installation-token" as never,
      moltzap: {
        _tag: "MoltzapRegistration",
        serverUrl: "wss://moltzap.example/ws",
        registrationSecret: "reg-secret",
      },
    });

    expect(result).toEqual({
      _tag: "Ok",
      value: "app-42",
    });

    const captured = fs.readFileSync(`${captureBase}.capture`, "utf-8").trim().split("\n");
    expect(captured).toEqual([
      "app",
      "gh-installation-token",
      "wss://moltzap.example/ws",
      "moltzap-key",
    ]);
  });
});
