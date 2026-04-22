import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, upsertManagedWorkerRegistration } from "../bin/ao-spawn-with-moltzap.ts";
import {
  createManagedSessionFileRegistry,
  managedSessionIdFromSessionName,
  resolveManagedSessionRegistryPath,
} from "../src/lifecycle/contracts.ts";
import { asAoSessionName, asProjectName } from "../src/types.ts";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

describe("upsertManagedWorkerRegistration", () => {
  it("writes a managed worker record beside the project config", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "zapbot-worker-registration-"));
    tempDirs.push(projectDir);
    const configPath = join(projectDir, "agent-orchestrator.yaml");
    const now = 1_717_171_717_000;

    const record = await upsertManagedWorkerRegistration({
      sessionName: "demo-42",
      projectId: "demo",
      configPath,
      worktree: "/tmp/demo-42",
      tmuxName: "demo-42",
      now: () => now,
    });

    expect(record).toEqual({
      id: managedSessionIdFromSessionName(asAoSessionName("demo-42")),
      tag: {
        managed: true,
        owner: "zapbot",
        projectName: "demo",
        sessionName: "demo-42",
        scope: "worker",
        origin: "ao-spawn-with-moltzap.ts",
        claimedAtMs: now,
      },
      tmuxName: "demo-42",
      worktree: "/tmp/demo-42",
      processId: null,
      phase: "active",
      lastHeartbeatAtMs: now,
    });

    const registry = createManagedSessionFileRegistry({
      registryPath: resolveManagedSessionRegistryPath({ configPath }),
    });
    const listed = await registry.listByProject(asProjectName("demo"));
    expect(listed).toEqual({
      _tag: "Ok",
      value: [record],
    });
  });

  it("updates an existing managed worker record without changing its claim time", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "zapbot-worker-registration-"));
    tempDirs.push(projectDir);
    const configPath = join(projectDir, "agent-orchestrator.yaml");

    await upsertManagedWorkerRegistration({
      sessionName: "demo-42",
      projectId: "demo",
      configPath,
      worktree: "/tmp/demo-old",
      tmuxName: "demo-worker-old",
      now: () => 1_000,
    });

    const updated = await upsertManagedWorkerRegistration({
      sessionName: "demo-42",
      projectId: "demo",
      configPath,
      worktree: "/tmp/demo-new",
      tmuxName: "demo-worker-new",
      now: () => 2_000,
    });

    expect(updated.tag.claimedAtMs).toBe(1_000);
    expect(updated.worktree).toBe("/tmp/demo-new");
    expect(updated.tmuxName).toBe("demo-worker-new");
    expect(updated.lastHeartbeatAtMs).toBe(2_000);

    const registry = createManagedSessionFileRegistry({
      registryPath: resolveManagedSessionRegistryPath({ configPath }),
    });
    const stored = await registry.get(
      managedSessionIdFromSessionName(asAoSessionName("demo-42")),
    );
    expect(stored).toEqual({
      _tag: "Ok",
      value: updated,
    });
  });

  it("does not treat ZAPBOT_* MoltZap vars as runtime env inputs", async () => {
    const sessionDataDir = mkdtempSync(join(tmpdir(), "zapbot-worker-runtime-env-"));
    tempDirs.push(sessionDataDir);
    const sessionName = "orch-1";
    writeFileSync(
      join(sessionDataDir, sessionName),
      "moltzap_sender_id=orch-1\n",
      "utf8",
    );

    process.env = { ...originalEnv };
    process.env.ZAPBOT_ENV_PATH = join(sessionDataDir, ".env");
    process.env.AO_DATA_DIR = sessionDataDir;
    process.env.AO_SESSION = sessionName;
    process.env.ZAPBOT_MOLTZAP_SERVER_URL = "wss://moltzap.example/ws";
    process.env.ZAPBOT_MOLTZAP_REGISTRATION_SECRET = "reg-secret";
    delete process.env.MOLTZAP_SERVER_URL;
    delete process.env.MOLTZAP_REGISTRATION_SECRET;
    delete process.env.MOLTZAP_ALLOWED_SENDERS;

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    await expect(main(["--prompt", "hello"])).rejects.toThrow("process.exit:1");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[ao-spawn-with-moltzap] MOLTZAP_SERVER_URL is required"),
    );
  });
});
