import { err, ok, type Result } from "../types.ts";
import type {
  ManagedSessionClaimRequest,
  ManagedSessionLifecycleError,
  ManagedSessionLifecycleReport,
  ManagedSessionRecord,
  ManagedSessionRegistry,
  ManagedSessionRuntime,
} from "./contracts.ts";

export interface ManagedSessionStartRequest extends ManagedSessionClaimRequest {
  readonly registry: ManagedSessionRegistry;
  readonly runtime: ManagedSessionRuntime;
}

export interface ManagedSessionStopRequest {
  readonly sessionId: ManagedSessionRecord["id"];
  readonly registry: ManagedSessionRegistry;
  readonly runtime: ManagedSessionRuntime;
}

export interface ManagedSessionReconcileRequest {
  readonly projectName: ManagedSessionRecord["tag"]["projectName"];
  readonly registry: ManagedSessionRegistry;
  readonly runtime: ManagedSessionRuntime;
}

export interface ManagedSessionController {
  readonly start: (
    request: ManagedSessionStartRequest,
  ) => Promise<Result<ManagedSessionRecord, ManagedSessionLifecycleError>>;
  readonly stop: (
    request: ManagedSessionStopRequest,
  ) => Promise<Result<void, ManagedSessionLifecycleError>>;
  readonly reconcile: (
    request: ManagedSessionReconcileRequest,
  ) => Promise<Result<ManagedSessionLifecycleReport, ManagedSessionLifecycleError>>;
  readonly shutdown: (
    request: ManagedSessionReconcileRequest,
  ) => Promise<Result<ManagedSessionLifecycleReport, ManagedSessionLifecycleError>>;
}

export function createManagedSessionController(): ManagedSessionController {
  return {
    start: startManagedSession,
    stop: stopManagedSession,
    reconcile: reconcileManagedSessions,
    shutdown: shutdownManagedSessions,
  };
}

export async function startManagedSession(
  request: ManagedSessionStartRequest,
): Promise<Result<ManagedSessionRecord, ManagedSessionLifecycleError>> {
  if (!isManagedRecord(request.record)) {
    return err({
      _tag: "ManagedSessionStopRejected",
      sessionId: request.record.id,
      reason: "only zapbot-managed sessions can be started through the lifecycle controller",
    });
  }

  const claimed = await request.registry.put({
    ...request.record,
    phase: "claimed",
  });
  if (claimed._tag === "Err") {
    return err(mapRegistryError(claimed.error));
  }

  const started = await request.runtime.start({
    record: {
      ...request.record,
      phase: "active",
    },
  });
  if (started._tag === "Err") {
    await request.registry.delete(request.record.id);
    return err(mapRuntimeError(started.error));
  }

  const persisted = await request.registry.put({
    ...started.value,
    phase: "active",
  });
  if (persisted._tag === "Err") {
    return err(mapRegistryError(persisted.error));
  }

  return ok(persisted.value);
}

export async function stopManagedSession(
  request: ManagedSessionStopRequest,
): Promise<Result<void, ManagedSessionLifecycleError>> {
  const existing = await request.registry.get(request.sessionId);
  if (existing._tag === "Err") {
    return err(mapRegistryError(existing.error));
  }
  if (existing.value === null) {
    return err({
      _tag: "ManagedSessionNotFound",
      sessionId: request.sessionId,
    });
  }
  if (!isManagedRecord(existing.value)) {
    return err({
      _tag: "ManagedSessionNotOwned",
      sessionId: request.sessionId,
    });
  }

  const draining = await request.registry.put({
    ...existing.value,
    phase: "draining",
  });
  if (draining._tag === "Err") {
    return err(mapRegistryError(draining.error));
  }

  const stopped = await request.runtime.stop(draining.value);
  if (stopped._tag === "Err") {
    return err(mapRuntimeError(stopped.error));
  }

  const deleted = await request.registry.delete(request.sessionId);
  if (deleted._tag === "Err") {
    return err(mapRegistryError(deleted.error));
  }

  return ok(undefined);
}

export async function reconcileManagedSessions(
  request: ManagedSessionReconcileRequest,
): Promise<Result<ManagedSessionLifecycleReport, ManagedSessionLifecycleError>> {
  const managed = await request.registry.listByProject(request.projectName);
  if (managed._tag === "Err") {
    return err(mapRegistryError(managed.error));
  }

  const live = await request.runtime.list(request.projectName);
  if (live._tag === "Err") {
    return err(mapRuntimeError(live.error));
  }

  const liveIds = new Set(live.value.map((record) => record.id));
  const managedRecords = managed.value.filter(isManagedRecord);
  for (const record of managedRecords) {
    const nextPhase = liveIds.has(record.id) ? "active" : "orphaned";
    if (record.phase === nextPhase) {
      continue;
    }
    const persisted = await request.registry.put({
      ...record,
      phase: nextPhase,
    });
    if (persisted._tag === "Err") {
      return err(mapRegistryError(persisted.error));
    }
  }

  return ok({
    projectName: request.projectName,
    sessionIds: managedRecords.map((record) => record.id),
  });
}

async function shutdownManagedSessions(
  request: ManagedSessionReconcileRequest,
): Promise<Result<ManagedSessionLifecycleReport, ManagedSessionLifecycleError>> {
  const managed = await request.registry.listByProject(request.projectName);
  if (managed._tag === "Err") {
    return err(mapRegistryError(managed.error));
  }

  const stoppedIds: ManagedSessionRecord["id"][] = [];
  for (const record of managed.value.filter(isManagedRecord)) {
    const stopped = await stopManagedSession({
      sessionId: record.id,
      registry: request.registry,
      runtime: request.runtime,
    });
    if (stopped._tag === "Err" && stopped.error._tag !== "ManagedSessionNotFound") {
      return stopped;
    }
    stoppedIds.push(record.id);
  }

  return ok({
    projectName: request.projectName,
    sessionIds: stoppedIds,
  });
}

function isManagedRecord(record: ManagedSessionClaimRequest["record"]): boolean {
  return record.tag.managed && record.tag.owner === "zapbot";
}

function mapRegistryError(error: ManagedSessionRegistry["put"] extends (
  ...args: never[]
) => Promise<Result<never, infer E>>
  ? E
  : never): ManagedSessionLifecycleError {
  switch (error._tag) {
    case "ManagedSessionNotFound":
      return {
        _tag: "ManagedSessionNotFound",
        sessionId: error.sessionId,
      };
    case "ManagedSessionAlreadyOwned":
      return {
        _tag: "ManagedSessionStopRejected",
        sessionId: error.sessionId,
        reason: "managed session is already owned by another project",
      };
    case "ManagedSessionRecordCorrupt":
    case "ManagedSessionRegistryUnavailable":
      return {
        _tag: "ManagedSessionRegistryFailed",
        cause: "reason" in error ? error.reason : error.cause,
      };
    default:
      return error;
  }
}

function mapRuntimeError(error: ManagedSessionRuntime["start"] extends (
  ...args: never[]
) => Promise<Result<never, infer E>>
  ? E
  : never): ManagedSessionLifecycleError {
  switch (error._tag) {
    case "ManagedSessionStartFailed":
    case "ManagedSessionStopFailed":
    case "ManagedSessionInspectFailed":
    case "ManagedSessionListFailed":
      return {
        _tag: "ManagedSessionRuntimeFailed",
        cause: error.cause,
      };
    default:
      return error;
  }
}
