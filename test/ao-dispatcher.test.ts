import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatch } from "../src/ao/dispatcher.ts";
import { fromSenderIds } from "../src/moltzap/identity-allowlist.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";
import {
  asIssueNumber,
  asProjectName,
  asRepoFullName,
} from "../src/types.ts";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
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
  printf '%s\\n' "$MOLTZAP_ALLOWED_SENDERS"
} > "$out"
exit 0
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${tempDir}:${originalPath ?? ""}`;

    const result = await dispatch({
      repo: asRepoFullName("acme/app"),
      issue: asIssueNumber(42),
      projectName: asProjectName("app"),
      configPath: captureBase,
      installationToken: "gh-installation-token" as never,
      moltzap: {
        _tag: "MoltzapStatic",
        serverUrl: "wss://moltzap.example/ws",
        apiKey: "moltzap-key",
        allowlistCsv: "agent-a",
        allowlist: fromSenderIds([asMoltzapSenderId("agent-a")]),
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
      "agent-a",
    ]);
  });
});
