import type { Result } from "../types.ts";
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
  throw new Error("not implemented");
}

export function startManagedSession(
  request: ManagedSessionStartRequest,
): Promise<Result<ManagedSessionRecord, ManagedSessionLifecycleError>> {
  throw new Error("not implemented");
}

export function stopManagedSession(
  request: ManagedSessionStopRequest,
): Promise<Result<void, ManagedSessionLifecycleError>> {
  throw new Error("not implemented");
}

export function reconcileManagedSessions(
  request: ManagedSessionReconcileRequest,
): Promise<Result<ManagedSessionLifecycleReport, ManagedSessionLifecycleError>> {
  throw new Error("not implemented");
}
