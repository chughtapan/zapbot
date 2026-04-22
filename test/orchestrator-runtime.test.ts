import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createManagedSessionFileRegistry,
  managedSessionIdFromSessionName,
  resolveManagedSessionRegistryPath,
} from "../src/lifecycle/contracts.ts";
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
  it("starts, claims, resolves, and forwards control via the managed registry", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "zapbot-ao-host-"));
    const logFile = join(workdir, "ao.log");
    const fakeAo = join(workdir, "ao");
    const configPath = join(workdir, "agent-orchestrator.yaml");
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

    const registry = createManagedSessionFileRegistry({
      registryPath: resolveManagedSessionRegistryPath({ projectDir: workdir }),
    });
    await registry.put({
      id: managedSessionIdFromSessionName(asAoSessionName("app-orchestrator")),
      tag: {
        managed: true,
        owner: "zapbot",
        projectName: asProjectName("app"),
        sessionName: asAoSessionName("app-orchestrator"),
        scope: "orchestrator",
        origin: "start.sh",
        claimedAtMs: Date.now(),
      },
      tmuxName: "app-orchestrator",
      worktree: workdir,
      processId: null,
      phase: "active",
      lastHeartbeatAtMs: Date.now(),
    });

    const host = createAoCliControlHost({
      aoBinary: fakeAo,
      configPath,
      registryPath: resolveManagedSessionRegistryPath({ projectDir: workdir }),
      env: {
        FAKE_AO_LOG: logFile,
        FAKE_AO_STATUS_JSON: statusJson,
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
      { title: "GitHub control", body: "github_comment_body:\n@zapbot please decide what to do next" },
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
    expect(log).toContain("status --project app --json");
    expect(log).toContain("send app-orchestrator --file");
    expect(log).toContain("# GitHub control");
    expect(log).toContain("github_comment_body:");
    expect(log).toContain("@zapbot please decide what to do next");
  });

  it("ignores an unregistered orchestrator session even if ao status exposes it by name", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "zapbot-ao-unmanaged-"));
    const logFile = join(workdir, "ao.log");
    const fakeAo = join(workdir, "ao");
    writeFileSync(
      fakeAo,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\\n' "$1" "$*" >> "\${FAKE_AO_LOG:?}"
if [ "$1" = "status" ]; then
  printf '%s' '[{"name":"app-orchestrator","role":"orchestrator","status":"running","metadata":{"senderId":"orch-1"}}]'
  exit 0
fi
if [ "$1" = "start" ]; then
  exit 0
fi
exit 1
`,
      "utf8",
    );
    chmodSync(fakeAo, 0o755);

    const host = createAoCliControlHost({
      aoBinary: fakeAo,
      configPath: join(workdir, "agent-orchestrator.yaml"),
      registryPath: resolveManagedSessionRegistryPath({ projectDir: workdir }),
      env: {
        FAKE_AO_LOG: logFile,
      },
      timeoutMs: 5_000,
    });

    const ready = await host.resolveReady(asProjectName("app"));
    expect(ready).toEqual({
      _tag: "Err",
      error: {
        _tag: "OrchestratorNotFound",
        projectName: "app",
      },
    });
  });
});
