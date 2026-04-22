import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asManagedSessionId,
  createManagedSessionFileRegistry,
  managedSessionIdFromSessionName,
  resolveManagedSessionRegistryPath,
  type ManagedSessionRecord,
  type ManagedSessionRegistry,
  type ManagedSessionRuntime,
} from "../src/lifecycle/contracts.ts";
import {
  createManagedSessionController,
  stopManagedSession,
} from "../src/lifecycle/controller.ts";
import { planManagedSessionGc, runManagedSessionGc } from "../src/lifecycle/gc.ts";
import {
  lifecycleDocsTouchpoints,
  listLifecycleCommands,
  parseLifecycleCommand,
  renderLifecycleHelp,
} from "../src/lifecycle/commands.ts";
import { asAoSessionName, asProjectName, ok } from "../src/types.ts";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("managed session registry", () => {
  it("persists managed records beside the project config", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "zapbot-managed-registry-"));
    tempDirs.push(projectDir);
    const registry = createManagedSessionFileRegistry({
      registryPath: resolveManagedSessionRegistryPath({
        configPath: join(projectDir, "agent-orchestrator.yaml"),
      }),
    });

    const record = managedRecord({
      projectName: asProjectName("demo"),
      sessionName: asAoSessionName("demo-orchestrator"),
      scope: "orchestrator",
    });
    const stored = await registry.put(record);
    expect(stored).toEqual({ _tag: "Ok", value: record });

    const listed = await registry.listByProject(asProjectName("demo"));
    expect(listed).toEqual({ _tag: "Ok", value: [record] });
  });
});

describe("managed session controller", () => {
  it("refuses to stop a non-managed record even when it is present in the registry", async () => {
    const record = {
      ...managedRecord({
        projectName: asProjectName("demo"),
        sessionName: asAoSessionName("manual-orchestrator"),
        scope: "orchestrator",
      }),
      tag: {
        managed: false,
        owner: "manual",
        projectName: asProjectName("demo"),
        sessionName: asAoSessionName("manual-orchestrator"),
        scope: "orchestrator",
        origin: "start.sh",
        claimedAtMs: Date.now(),
      },
    } as unknown as ManagedSessionRecord;

    const runtimeStop = vi.fn(async () => ok(undefined));
    const registry: ManagedSessionRegistry = {
      put: async (next) => ok(next),
      get: async () => ok(record),
      listByProject: async () => ok([record]),
      delete: async () => ok(undefined),
    };
    const runtime: ManagedSessionRuntime = {
      start: async ({ record: next }) => ok(next),
      stop: runtimeStop,
      inspect: async () => ok(record),
      list: async () => ok([record]),
    };

    const stopped = await stopManagedSession({
      sessionId: record.id,
      registry,
      runtime,
    });

    expect(stopped).toEqual({
      _tag: "Err",
      error: {
        _tag: "ManagedSessionNotOwned",
        sessionId: record.id,
      },
    });
    expect(runtimeStop).not.toHaveBeenCalled();
  });

  it("reconciles missing managed sessions into the orphaned phase", async () => {
    const record = managedRecord({
      projectName: asProjectName("demo"),
      sessionName: asAoSessionName("demo-orchestrator"),
      scope: "orchestrator",
      phase: "active",
    });
    let persisted = record;
    const registry: ManagedSessionRegistry = {
      put: async (next) => {
        persisted = next;
        return ok(next);
      },
      get: async () => ok(persisted),
      listByProject: async () => ok([persisted]),
      delete: async () => ok(undefined),
    };
    const runtime: ManagedSessionRuntime = {
      start: async ({ record: next }) => ok(next),
      stop: async () => ok(undefined),
      inspect: async () => ok(null),
      list: async () => ok([]),
    };

    const controller = createManagedSessionController();
    const reconciled = await controller.reconcile({
      projectName: asProjectName("demo"),
      registry,
      runtime,
    });

    expect(reconciled).toEqual({
      _tag: "Ok",
      value: {
        projectName: "demo",
        sessionIds: [record.id],
      },
    });
    expect(persisted.phase).toBe("orphaned");
  });
});

describe("managed session gc", () => {
  it("plans and removes only managed stale sessions", async () => {
    const stale = managedRecord({
      projectName: asProjectName("demo"),
      sessionName: asAoSessionName("demo-42"),
      scope: "worker",
      phase: "orphaned",
      lastHeartbeatAtMs: Date.now() - 20_000,
    });
    const retained = managedRecord({
      projectName: asProjectName("demo"),
      sessionName: asAoSessionName("demo-orchestrator"),
      scope: "orchestrator",
      phase: "active",
      lastHeartbeatAtMs: Date.now(),
    });
    const manual = {
      ...managedRecord({
        projectName: asProjectName("demo"),
        sessionName: asAoSessionName("manual-1"),
        scope: "worker",
      }),
      tag: {
        managed: false,
        owner: "manual",
        projectName: asProjectName("demo"),
        sessionName: asAoSessionName("manual-1"),
        scope: "worker",
        origin: "ao-spawn-with-moltzap.ts",
        claimedAtMs: Date.now(),
      },
    } as unknown as ManagedSessionRecord;

    let records: ManagedSessionRecord[] = [stale, retained, manual];
    const registry: ManagedSessionRegistry = {
      put: async (next) => {
        records = [...records.filter((record) => record.id !== next.id), next];
        return ok(next);
      },
      get: async (sessionId) => ok(records.find((record) => record.id === sessionId) ?? null),
      listByProject: async () => ok(records),
      delete: async (sessionId) => {
        records = records.filter((record) => record.id !== sessionId);
        return ok(undefined);
      },
    };
    const runtimeStop = vi.fn(async () => ok(undefined));
    const runtime: ManagedSessionRuntime = {
      start: async ({ record: next }) => ok(next),
      stop: runtimeStop,
      inspect: async () => ok(null),
      list: async () => ok([retained]),
    };
    const request = {
      policy: {
        projectName: asProjectName("demo"),
        pruneStopped: true,
        pruneOrphaned: true,
        maxIdleMs: 5_000,
      },
      registry,
      runtime,
    } as const;

    const plan = await planManagedSessionGc(request);
    expect(plan._tag).toBe("Ok");
    if (plan._tag !== "Ok") {
      return;
    }
    expect(plan.value.stale.map((record) => record.id)).toEqual([stale.id]);

    const report = await runManagedSessionGc(request);
    expect(report).toEqual({
      _tag: "Ok",
      value: {
        projectName: "demo",
        stopped: [stale.id],
        retained: [retained.id],
      },
    });
    expect(runtimeStop).not.toHaveBeenCalled();
    expect(records.map((record) => record.id)).toEqual([retained.id, manual.id]);
  });
});

describe("lifecycle commands", () => {
  it("parses stop and renders managed-only help", () => {
    expect(parseLifecycleCommand({ argv: ["stop", "demo-42"] })).toEqual({
      _tag: "Ok",
      value: {
        name: "stop",
        args: ["demo-42"],
      },
    });
    const help = renderLifecycleHelp(listLifecycleCommands());
    expect(help).toContain("status");
    expect(help).toContain("Managed sessions only.");
    expect(lifecycleDocsTouchpoints()).toHaveLength(2);
  });
});

function managedRecord(input: {
  readonly projectName: ReturnType<typeof asProjectName>;
  readonly sessionName: ReturnType<typeof asAoSessionName>;
  readonly scope: ManagedSessionRecord["tag"]["scope"];
  readonly phase?: ManagedSessionRecord["phase"];
  readonly lastHeartbeatAtMs?: number | null;
}): ManagedSessionRecord {
  return {
    id: managedSessionIdFromSessionName(input.sessionName),
    tag: {
      managed: true,
      owner: "zapbot",
      projectName: input.projectName,
      sessionName: input.sessionName,
      scope: input.scope,
      origin: input.scope === "orchestrator" ? "start.sh" : "ao-spawn-with-moltzap.ts",
      claimedAtMs: Date.now(),
    },
    tmuxName: input.sessionName as string,
    worktree: "/tmp/demo",
    processId: 123,
    phase: input.phase ?? "active",
    lastHeartbeatAtMs: input.lastHeartbeatAtMs ?? Date.now(),
  };
}
