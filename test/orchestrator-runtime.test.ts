import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureProjectOrchestrator,
  forwardControlPrompt,
  createAoCliControlHost,
  type AoControlHost,
} from "../src/orchestrator/runtime.ts";
import { asAoSessionName, asProjectName, err, ok } from "../src/types.ts";
import { asMoltzapSenderId } from "../src/moltzap/types.ts";

describe("ensureProjectOrchestrator", () => {
  it("starts and resolves the persistent orchestrator", async () => {
    const calls: string[] = [];
    const host: AoControlHost = {
      ensureStarted: async () => {
        calls.push("ensureStarted");
        return ok(undefined);
      },
      resolveReady: async () => {
        calls.push("resolveReady");
        return ok({
          session: asAoSessionName("app-orchestrator"),
          senderId: asMoltzapSenderId("orch-1"),
          mode: "started",
        });
      },
      sendPrompt: async () => ok(undefined),
    };
    const result = await ensureProjectOrchestrator(asProjectName("app"), host);
    expect(result._tag).toBe("Ok");
    expect(calls).toEqual(["ensureStarted", "resolveReady"]);
  });
});

describe("forwardControlPrompt", () => {
  it("sends the rendered prompt to the ready orchestrator session", async () => {
    const sent: Array<{ session: string; title: string }> = [];
    const host: AoControlHost = {
      ensureStarted: async () => ok(undefined),
      resolveReady: async () =>
        ok({
          session: asAoSessionName("app-orchestrator"),
          senderId: asMoltzapSenderId("orch-1"),
          mode: "reused",
        }),
      sendPrompt: async (session, prompt) => {
        sent.push({ session, title: prompt.title });
        return ok(undefined);
      },
    };
    const result = await forwardControlPrompt(
      asProjectName("app"),
      { title: "hello", body: "body" },
      host,
    );
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        session: "app-orchestrator",
        senderId: "orch-1",
      },
    });
    expect(sent).toEqual([{ session: "app-orchestrator", title: "hello" }]);
  });

  it("bubbles AoSendFailed as a typed error", async () => {
    const host: AoControlHost = {
      ensureStarted: async () => ok(undefined),
      resolveReady: async () =>
        ok({
          session: asAoSessionName("app-orchestrator"),
          senderId: asMoltzapSenderId("orch-1"),
          mode: "reused",
        }),
      sendPrompt: async () => err({ _tag: "AoSendFailed", cause: "pipe closed" }),
    };
    const result = await forwardControlPrompt(
      asProjectName("app"),
      { title: "hello", body: "body" },
      host,
    );
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "AoSendFailed", cause: "pipe closed" },
    });
  });
});

describe("createAoCliControlHost", () => {
  it("starts, resolves, and forwards control via the AO CLI", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "zapbot-ao-host-"));
    const logFile = join(workdir, "ao.log");
    const fakeAo = join(workdir, "ao");
    const statusJson = JSON.stringify([
      {
        name: "app-orchestrator",
        role: "orchestrator",
        status: "running",
        metadata: { senderId: "orch-1" },
      },
    ]);
    writeFileSync(
      fakeAo,
      `#!/usr/bin/env bash
set -euo pipefail
log="\${FAKE_AO_LOG:?}"
cmd="\${1:-}"
shift || true
case "$cmd" in
  start)
    printf 'start %s\\n' "$*" >> "$log"
    printf 'env AO_CONFIG_PATH=%s AO_CALLER_TYPE=%s\\n' "\${AO_CONFIG_PATH:-}" "\${AO_CALLER_TYPE:-}" >> "$log"
    ;;
  status)
    printf 'status %s\\n' "$*" >> "$log"
    printf '%s' "\${FAKE_AO_STATUS_JSON:-[]}"
    ;;
  send)
    printf 'send %s\\n' "$*" >> "$log"
    file=""
    while (($#)); do
      if [[ "$1" == "--file" ]]; then
        file="\${2:-}"
        shift 2
        continue
      fi
      shift
    done
    if [[ -n "$file" ]]; then
      printf '\\n---prompt---\\n' >> "$log"
      cat "$file" >> "$log"
      printf '\\n---end---\\n' >> "$log"
    fi
    ;;
  *)
    printf 'unexpected %s\\n' "$cmd" >> "$log"
    exit 1
    ;;
esac
`,
      "utf8",
    );
    chmodSync(fakeAo, 0o755);

    const host = createAoCliControlHost({
      aoBinary: fakeAo,
      configPath: "/tmp/agent-orchestrator.yaml",
      env: {
        FAKE_AO_LOG: logFile,
        FAKE_AO_STATUS_JSON: statusJson,
        AO_CALLER_TYPE: "orchestrator",
        MOLTZAP_SERVER_URL: "ws://127.0.0.1:41973",
      },
      timeoutMs: 5_000,
    });

    const ready = await host.resolveReady(asProjectName("app"));
    expect(ready).toEqual({
      _tag: "Ok",
      value: {
        session: "app-orchestrator",
        senderId: "orch-1",
        mode: "reused",
      },
    });

    const forwarded = await forwardControlPrompt(
      asProjectName("app"),
      { title: "GitHub control", body: "github_comment_body:\n@zapbot plan this" },
      host,
    );
    expect(forwarded).toEqual({
      _tag: "Ok",
      value: {
        session: "app-orchestrator",
        senderId: "orch-1",
      },
    });

    const log = readFileSync(logFile, "utf8");
    expect(log).toContain("start app --no-dashboard");
    expect(log).toContain("env AO_CONFIG_PATH=/tmp/agent-orchestrator.yaml AO_CALLER_TYPE=orchestrator");
    expect(log).toContain("status --project app --json");
    expect(log).toContain("send app-orchestrator --file");
    expect(log).toContain("# GitHub control");
    expect(log).toContain("github_comment_body:");
    expect(log).toContain("@zapbot plan this");
  });

  it("holds the orchestrator as not ready when MoltZap is enabled but sender metadata is missing", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "zapbot-ao-host-"));
    const logFile = join(workdir, "ao.log");
    const fakeAo = join(workdir, "ao");
    const statusJson = JSON.stringify([
      {
        name: "app-orchestrator",
        role: "orchestrator",
        status: "running",
        metadata: {},
      },
    ]);
    writeFileSync(
      fakeAo,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "\${FAKE_AO_STATUS_JSON:-[]}"
`,
      "utf8",
    );
    chmodSync(fakeAo, 0o755);

    const host = createAoCliControlHost({
      aoBinary: fakeAo,
      configPath: "/tmp/agent-orchestrator.yaml",
      env: {
        FAKE_AO_LOG: logFile,
        FAKE_AO_STATUS_JSON: statusJson,
        MOLTZAP_SERVER_URL: "ws://127.0.0.1:41973",
      },
      timeoutMs: 5_000,
    });

    const ready = await host.resolveReady(asProjectName("app"));
    expect(ready).toEqual({
      _tag: "Err",
      error: {
        _tag: "OrchestratorNotReady",
        projectName: "app",
        reason: "orchestrator session app-orchestrator is missing moltzap_sender_id metadata",
      },
    });
  });
});
