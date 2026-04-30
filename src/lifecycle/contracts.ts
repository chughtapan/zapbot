import type { AoSessionName, ProjectName, Result } from "../types.ts";

export type ManagedSessionId = string & { readonly __brand: "ManagedSessionId" };
export type ManagedSessionScope = "orchestrator" | "worker" | "bridge";
export type ManagedSessionPhase = "claimed" | "active" | "draining" | "stopped" | "orphaned";

export interface ManagedSessionTag {
  readonly managed: true;
  readonly owner: "zapbot";
  readonly projectName: ProjectName;
  readonly sessionName: AoSessionName;
  readonly scope: ManagedSessionScope;
  readonly origin: "start.sh" | "webhook-bridge.ts";
  readonly claimedAtMs: number;
}

export interface ManagedSessionRecord {
  readonly id: ManagedSessionId;
  readonly tag: ManagedSessionTag;
  readonly tmuxName: string | null;
  readonly worktree: string | null;
  readonly processId: number | null;
  readonly phase: ManagedSessionPhase;
  readonly lastHeartbeatAtMs: number | null;
}

export interface ManagedSessionClaimRequest {
  readonly record: ManagedSessionRecord;
}

export interface ManagedSessionReleaseRequest {
  readonly sessionId: ManagedSessionId;
  readonly projectName: ProjectName;
}

export interface ManagedSessionRegistry {
  readonly put: (
    record: ManagedSessionRecord,
  ) => Promise<Result<ManagedSessionRecord, ManagedSessionRegistryError>>;
  readonly get: (
    sessionId: ManagedSessionId,
  ) => Promise<Result<ManagedSessionRecord | null, ManagedSessionRegistryError>>;
  readonly listByProject: (
    projectName: ProjectName,
  ) => Promise<Result<ReadonlyArray<ManagedSessionRecord>, ManagedSessionRegistryError>>;
  readonly delete: (
    sessionId: ManagedSessionId,
  ) => Promise<Result<void, ManagedSessionRegistryError>>;
}

export interface ManagedSessionRuntime {
  readonly start: (
    request: ManagedSessionClaimRequest,
  ) => Promise<Result<ManagedSessionRecord, ManagedSessionRuntimeError>>;
  readonly stop: (
    record: ManagedSessionRecord,
  ) => Promise<Result<void, ManagedSessionRuntimeError>>;
  readonly inspect: (
    sessionId: ManagedSessionId,
  ) => Promise<Result<ManagedSessionRecord | null, ManagedSessionRuntimeError>>;
  readonly list: (
    projectName: ProjectName,
  ) => Promise<Result<ReadonlyArray<ManagedSessionRecord>, ManagedSessionRuntimeError>>;
}

export interface ManagedSessionGcPolicy {
  readonly projectName: ProjectName;
  readonly pruneStopped: boolean;
  readonly pruneOrphaned: boolean;
  readonly maxIdleMs: number;
}

export interface ManagedSessionGcPlan {
  readonly projectName: ProjectName;
  readonly candidates: ReadonlyArray<ManagedSessionRecord>;
  readonly stale: ReadonlyArray<ManagedSessionRecord>;
}

export interface ManagedSessionGcReport {
  readonly projectName: ProjectName;
  readonly stopped: ReadonlyArray<ManagedSessionId>;
  readonly retained: ReadonlyArray<ManagedSessionId>;
}

export interface ManagedSessionLifecycleReport {
  readonly projectName: ProjectName;
  readonly sessionIds: ReadonlyArray<ManagedSessionId>;
}

export type ManagedSessionRegistryError =
  | { readonly _tag: "ManagedSessionRegistryUnavailable"; readonly cause: string }
  | { readonly _tag: "ManagedSessionRecordCorrupt"; readonly sessionId: ManagedSessionId; readonly reason: string }
  | { readonly _tag: "ManagedSessionAlreadyOwned"; readonly sessionId: ManagedSessionId }
  | { readonly _tag: "ManagedSessionNotFound"; readonly sessionId: ManagedSessionId };

export type ManagedSessionRuntimeError =
  | { readonly _tag: "ManagedSessionStartFailed"; readonly cause: string }
  | { readonly _tag: "ManagedSessionStopFailed"; readonly cause: string }
  | { readonly _tag: "ManagedSessionInspectFailed"; readonly cause: string }
  | { readonly _tag: "ManagedSessionListFailed"; readonly cause: string };

export type ManagedSessionLifecycleError =
  | { readonly _tag: "ManagedSessionRegistryFailed"; readonly cause: string }
  | { readonly _tag: "ManagedSessionRuntimeFailed"; readonly cause: string }
  | { readonly _tag: "ManagedSessionNotOwned"; readonly sessionId: ManagedSessionId }
  | { readonly _tag: "ManagedSessionNotFound"; readonly sessionId: ManagedSessionId }
  | { readonly _tag: "ManagedSessionStopRejected"; readonly sessionId: ManagedSessionId; readonly reason: string };

export type ManagedSessionGcError =
  | { readonly _tag: "ManagedSessionGcRegistryFailed"; readonly cause: string }
  | { readonly _tag: "ManagedSessionGcRuntimeFailed"; readonly cause: string }
  | { readonly _tag: "ManagedSessionGcPolicyRejected"; readonly reason: string };

export type LifecycleCommandName = "status" | "stop" | "gc" | "reconcile" | "help";

export interface LifecycleCommandSpec {
  readonly name: LifecycleCommandName;
  readonly summary: string;
  readonly managedOnly: boolean;
  readonly docAnchor: "README.md" | "ARCHITECTURE.md";
}

export interface LifecycleDocsTouchpoint {
  readonly file: "README.md" | "ARCHITECTURE.md";
  readonly section: string;
  readonly command: LifecycleCommandName;
  readonly note: string;
}

export type LifecycleCommandError =
  | { readonly _tag: "LifecycleCommandUnknown"; readonly input: string }
  | { readonly _tag: "LifecycleCommandMissingSession"; readonly command: LifecycleCommandName }
  | { readonly _tag: "LifecycleCommandInvalidTarget"; readonly input: string; readonly reason: string };
