import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertManagedWorkerRegistration } from "../bin/ao-spawn-with-moltzap.ts";
import {
  createManagedSessionFileRegistry,
  managedSessionIdFromSessionName,
  resolveManagedSessionRegistryPath,
} from "../src/lifecycle/contracts.ts";
import { asAoSessionName, asProjectName } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("upsertManagedWorkerRegistration", () => {
  it("writes a managed worker record beside the project config", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "zapbot-worker-registration-"));
    tempDirs.push(projectDir);
    const registryPath = resolveManagedSessionRegistryPath({ projectDir });
    const now = 1_717_171_717_000;

    const record = await upsertManagedWorkerRegistration({
      sessionName: "demo-42",
      projectId: "demo",
      registryPath,
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
      registryPath,
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
    const registryPath = resolveManagedSessionRegistryPath({ projectDir });

    await upsertManagedWorkerRegistration({
      sessionName: "demo-42",
      projectId: "demo",
      registryPath,
      worktree: "/tmp/demo-old",
      tmuxName: "demo-worker-old",
      now: () => 1_000,
    });

    const updated = await upsertManagedWorkerRegistration({
      sessionName: "demo-42",
      projectId: "demo",
      registryPath,
      worktree: "/tmp/demo-new",
      tmuxName: "demo-worker-new",
      now: () => 2_000,
    });

    expect(updated.tag.claimedAtMs).toBe(1_000);
    expect(updated.worktree).toBe("/tmp/demo-new");
    expect(updated.tmuxName).toBe("demo-worker-new");
    expect(updated.lastHeartbeatAtMs).toBe(2_000);

    const registry = createManagedSessionFileRegistry({
      registryPath,
    });
    const stored = await registry.get(
      managedSessionIdFromSessionName(asAoSessionName("demo-42")),
    );
    expect(stored).toEqual({
      _tag: "Ok",
      value: updated,
    });
  });
});
