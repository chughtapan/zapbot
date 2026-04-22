import { err, ok, type Result } from "../types.ts";
import type {
  ManagedSessionGcError,
  ManagedSessionGcPlan,
  ManagedSessionGcPolicy,
  ManagedSessionGcReport,
  ManagedSessionRecord,
  ManagedSessionRegistryError,
  ManagedSessionRegistry,
  ManagedSessionRuntimeError,
  ManagedSessionRuntime,
} from "./contracts.ts";

export interface ManagedSessionGcRequest {
  readonly policy: ManagedSessionGcPolicy;
  readonly registry: ManagedSessionRegistry;
  readonly runtime: ManagedSessionRuntime;
}

export async function planManagedSessionGc(
  request: ManagedSessionGcRequest,
): Promise<Result<ManagedSessionGcPlan, ManagedSessionGcError>> {
  if (request.policy.maxIdleMs < 0) {
    return err({
      _tag: "ManagedSessionGcPolicyRejected",
      reason: "maxIdleMs must be greater than or equal to zero",
    });
  }

  const managed = await request.registry.listByProject(request.policy.projectName);
  if (managed._tag === "Err") {
    return err({
      _tag: "ManagedSessionGcRegistryFailed",
      cause: stringifyRegistryError(managed.error),
    });
  }

  const live = await request.runtime.list(request.policy.projectName);
  if (live._tag === "Err") {
    return err({
      _tag: "ManagedSessionGcRuntimeFailed",
      cause: live.error.cause,
    });
  }

  const now = Date.now();
  const liveIds = new Set(live.value.map((record) => record.id));
  const candidates = managed.value.filter(isManagedRecord);
  const stale = candidates.filter((record) =>
    isStaleManagedSession(record, liveIds, now, request.policy),
  );

  return ok({
    projectName: request.policy.projectName,
    candidates,
    stale,
  });
}

export async function runManagedSessionGc(
  request: ManagedSessionGcRequest,
): Promise<Result<ManagedSessionGcReport, ManagedSessionGcError>> {
  const plan = await planManagedSessionGc(request);
  if (plan._tag === "Err") {
    return plan;
  }

  const live = await request.runtime.list(request.policy.projectName);
  if (live._tag === "Err") {
    return err({
      _tag: "ManagedSessionGcRuntimeFailed",
      cause: stringifyRuntimeError(live.error),
    });
  }

  const liveIds = new Set(live.value.map((record) => record.id));
  const stopped: ManagedSessionRecord["id"][] = [];
  for (const record of plan.value.stale) {
    if (liveIds.has(record.id)) {
      const runtimeStopped = await request.runtime.stop(record);
      if (runtimeStopped._tag === "Err") {
        return err({
          _tag: "ManagedSessionGcRuntimeFailed",
          cause: runtimeStopped.error.cause,
        });
      }
    }
    const deleted = await request.registry.delete(record.id);
    if (deleted._tag === "Err") {
      return err({
        _tag: "ManagedSessionGcRegistryFailed",
        cause: stringifyRegistryError(deleted.error),
      });
    }
    stopped.push(record.id);
  }

  const retained = plan.value.candidates
    .map((record) => record.id)
    .filter((sessionId) => !stopped.includes(sessionId));

  return ok({
    projectName: request.policy.projectName,
    stopped,
    retained,
  });
}

function isManagedRecord(record: ManagedSessionRecord): boolean {
  return record.tag.managed && record.tag.owner === "zapbot";
}

function isStaleManagedSession(
  record: ManagedSessionRecord,
  liveIds: ReadonlySet<ManagedSessionRecord["id"]>,
  now: number,
  policy: ManagedSessionGcPolicy,
): boolean {
  if (record.phase === "stopped") {
    return policy.pruneStopped;
  }
  if (record.phase === "orphaned") {
    return policy.pruneOrphaned;
  }

  const isLive = liveIds.has(record.id);
  if (!isLive) {
    return policy.pruneOrphaned;
  }

  if (record.lastHeartbeatAtMs === null) {
    return false;
  }
  return now - record.lastHeartbeatAtMs >= policy.maxIdleMs;
}

function stringifyRegistryError(error: ManagedSessionRegistryError): string {
  switch (error._tag) {
    case "ManagedSessionRegistryUnavailable":
      return error.cause;
    case "ManagedSessionRecordCorrupt":
      return error.reason;
    case "ManagedSessionAlreadyOwned":
    case "ManagedSessionNotFound":
      return error.sessionId;
  }
}

function stringifyRuntimeError(error: ManagedSessionRuntimeError): string {
  return error.cause;
}
