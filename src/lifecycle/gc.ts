import type { Result } from "../types.ts";
import type {
  ManagedSessionGcError,
  ManagedSessionGcPlan,
  ManagedSessionGcPolicy,
  ManagedSessionGcReport,
  ManagedSessionRegistry,
  ManagedSessionRuntime,
} from "./contracts.ts";

export interface ManagedSessionGcRequest {
  readonly policy: ManagedSessionGcPolicy;
  readonly registry: ManagedSessionRegistry;
  readonly runtime: ManagedSessionRuntime;
}

export function planManagedSessionGc(
  request: ManagedSessionGcRequest,
): Promise<Result<ManagedSessionGcPlan, ManagedSessionGcError>> {
  throw new Error("not implemented");
}

export function runManagedSessionGc(
  request: ManagedSessionGcRequest,
): Promise<Result<ManagedSessionGcReport, ManagedSessionGcError>> {
  throw new Error("not implemented");
}
