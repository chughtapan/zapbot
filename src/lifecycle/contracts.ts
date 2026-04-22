import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asAoSessionName, err, ok, type AoSessionName, type ProjectName, type Result } from "../types.ts";

export type ManagedSessionId = string & { readonly __brand: "ManagedSessionId" };
export type ManagedSessionScope = "orchestrator" | "worker" | "bridge";
export type ManagedSessionPhase = "claimed" | "active" | "draining" | "stopped" | "orphaned";
const MANAGED_SESSION_REGISTRY_VERSION = 1;
const MANAGED_SESSION_REGISTRY_FILE = ".zapbot-managed-sessions.json";

export interface ManagedSessionTag {
  readonly managed: true;
  readonly owner: "zapbot";
  readonly projectName: ProjectName;
  readonly sessionName: AoSessionName;
  readonly scope: ManagedSessionScope;
  readonly origin: "start.sh" | "ao-spawn-with-moltzap.ts" | "webhook-bridge.ts";
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

interface ManagedSessionRegistryFile {
  readonly version: typeof MANAGED_SESSION_REGISTRY_VERSION;
  readonly records: ReadonlyArray<ManagedSessionRecord>;
}

export interface ManagedSessionRegistryPathOptions {
  readonly configPath?: string | null;
  readonly projectDir?: string | null;
}

export interface ManagedSessionFileRegistryOptions {
  readonly registryPath: string;
}

export function asManagedSessionId(value: string): ManagedSessionId {
  return value as ManagedSessionId;
}

export function managedSessionIdFromSessionName(
  sessionName: AoSessionName,
): ManagedSessionId {
  return asManagedSessionId(sessionName as string);
}

export function isManagedSessionRecord(record: ManagedSessionRecord): boolean {
  return record.tag.managed && record.tag.owner === "zapbot";
}

export function resolveManagedSessionRegistryPath(
  options: ManagedSessionRegistryPathOptions,
): string {
  if (typeof options.projectDir === "string" && options.projectDir.trim().length > 0) {
    return join(options.projectDir.trim(), MANAGED_SESSION_REGISTRY_FILE);
  }
  if (typeof options.configPath === "string" && options.configPath.trim().length > 0) {
    return join(dirname(options.configPath.trim()), MANAGED_SESSION_REGISTRY_FILE);
  }
  return join(process.cwd(), MANAGED_SESSION_REGISTRY_FILE);
}

export function createManagedSessionFileRegistry(
  options: ManagedSessionFileRegistryOptions,
): ManagedSessionRegistry {
  const registryPath = options.registryPath;

  async function loadRegistryFile(): Promise<Result<ManagedSessionRegistryFile, ManagedSessionRegistryError>> {
    let raw: string;
    try {
      raw = await readFile(registryPath, "utf8");
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) {
        return ok(emptyRegistryFile());
      }
      return err({
        _tag: "ManagedSessionRegistryUnavailable",
        cause: stringifyError(error),
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return err({
        _tag: "ManagedSessionRecordCorrupt",
        sessionId: asManagedSessionId("registry"),
        reason: stringifyError(error),
      });
    }

    return decodeRegistryFile(parsed);
  }

  async function storeRegistryFile(
    next: ManagedSessionRegistryFile,
  ): Promise<Result<void, ManagedSessionRegistryError>> {
    try {
      await mkdir(dirname(registryPath), { recursive: true });
      const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tempPath, registryPath);
      return ok(undefined);
    } catch (error) {
      return err({
        _tag: "ManagedSessionRegistryUnavailable",
        cause: stringifyError(error),
      });
    }
  }

  return {
    put: async (record) => {
      const current = await loadRegistryFile();
      if (current._tag === "Err") {
        return current;
      }
      const existing = current.value.records.find((candidate) => candidate.id === record.id);
      if (
        existing !== undefined &&
        existing.tag.projectName !== record.tag.projectName
      ) {
        return err({
          _tag: "ManagedSessionAlreadyOwned",
          sessionId: record.id,
        });
      }

      const next: ManagedSessionRegistryFile = {
        version: MANAGED_SESSION_REGISTRY_VERSION,
        records: [
          ...current.value.records.filter((candidate) => candidate.id !== record.id),
          record,
        ],
      };
      const stored = await storeRegistryFile(next);
      if (stored._tag === "Err") {
        return stored;
      }
      return ok(record);
    },
    get: async (sessionId) => {
      const current = await loadRegistryFile();
      if (current._tag === "Err") {
        return current;
      }
      return ok(current.value.records.find((record) => record.id === sessionId) ?? null);
    },
    listByProject: async (projectName) => {
      const current = await loadRegistryFile();
      if (current._tag === "Err") {
        return current;
      }
      return ok(
        current.value.records.filter((record) => record.tag.projectName === projectName),
      );
    },
    delete: async (sessionId) => {
      const current = await loadRegistryFile();
      if (current._tag === "Err") {
        return current;
      }
      const next: ManagedSessionRegistryFile = {
        version: MANAGED_SESSION_REGISTRY_VERSION,
        records: current.value.records.filter((record) => record.id !== sessionId),
      };
      return await storeRegistryFile(next);
    },
  };
}

function emptyRegistryFile(): ManagedSessionRegistryFile {
  return {
    version: MANAGED_SESSION_REGISTRY_VERSION,
    records: [],
  };
}

function decodeRegistryFile(
  input: unknown,
): Result<ManagedSessionRegistryFile, ManagedSessionRegistryError> {
  if (input === null || typeof input !== "object") {
    return err({
      _tag: "ManagedSessionRecordCorrupt",
      sessionId: asManagedSessionId("registry"),
      reason: "registry payload must be an object",
    });
  }
  const version = (input as { readonly version?: unknown }).version;
  const records = (input as { readonly records?: unknown }).records;
  if (version !== MANAGED_SESSION_REGISTRY_VERSION || !Array.isArray(records)) {
    return err({
      _tag: "ManagedSessionRecordCorrupt",
      sessionId: asManagedSessionId("registry"),
      reason: "registry payload must contain version=1 and records[]",
    });
  }

  const decoded: ManagedSessionRecord[] = [];
  for (const value of records) {
    const record = decodeManagedSessionRecord(value);
    if (record._tag === "Err") {
      return record;
    }
    decoded.push(record.value);
  }
  return ok({
    version: MANAGED_SESSION_REGISTRY_VERSION,
    records: decoded,
  });
}

function decodeManagedSessionRecord(
  input: unknown,
): Result<ManagedSessionRecord, ManagedSessionRegistryError> {
  if (input === null || typeof input !== "object") {
    return corruptManagedSessionRecord("unknown", "record must be an object");
  }
  const candidate = input as {
    readonly id?: unknown;
    readonly tag?: unknown;
    readonly tmuxName?: unknown;
    readonly worktree?: unknown;
    readonly processId?: unknown;
    readonly phase?: unknown;
    readonly lastHeartbeatAtMs?: unknown;
  };
  const tag = decodeManagedSessionTag(candidate.tag, candidate.id);
  if (tag._tag === "Err") {
    return tag;
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    return corruptManagedSessionRecord("unknown", "record.id must be a non-empty string");
  }
  if (!isNullableString(candidate.tmuxName)) {
    return corruptManagedSessionRecord(candidate.id, "record.tmuxName must be string|null");
  }
  if (!isNullableString(candidate.worktree)) {
    return corruptManagedSessionRecord(candidate.id, "record.worktree must be string|null");
  }
  if (!isNullableNumber(candidate.processId)) {
    return corruptManagedSessionRecord(candidate.id, "record.processId must be number|null");
  }
  if (!isNullableNumber(candidate.lastHeartbeatAtMs)) {
    return corruptManagedSessionRecord(candidate.id, "record.lastHeartbeatAtMs must be number|null");
  }
  if (!isManagedSessionPhase(candidate.phase)) {
    return corruptManagedSessionRecord(candidate.id, "record.phase must be a managed-session phase");
  }
  return ok({
    id: asManagedSessionId(candidate.id),
    tag: tag.value,
    tmuxName: candidate.tmuxName ?? null,
    worktree: candidate.worktree ?? null,
    processId: candidate.processId ?? null,
    phase: candidate.phase,
    lastHeartbeatAtMs: candidate.lastHeartbeatAtMs ?? null,
  });
}

function decodeManagedSessionTag(
  input: unknown,
  sessionId: unknown,
): Result<ManagedSessionTag, ManagedSessionRegistryError> {
  if (input === null || typeof input !== "object") {
    return corruptManagedSessionRecord(sessionId, "record.tag must be an object");
  }
  const tag = input as {
    readonly managed?: unknown;
    readonly owner?: unknown;
    readonly projectName?: unknown;
    readonly sessionName?: unknown;
    readonly scope?: unknown;
    readonly origin?: unknown;
    readonly claimedAtMs?: unknown;
  };
  if (tag.managed !== true || tag.owner !== "zapbot") {
    return corruptManagedSessionRecord(sessionId, "record.tag must be a zapbot-managed tag");
  }
  if (typeof tag.projectName !== "string" || tag.projectName.length === 0) {
    return corruptManagedSessionRecord(sessionId, "record.tag.projectName must be a non-empty string");
  }
  if (typeof tag.sessionName !== "string" || tag.sessionName.length === 0) {
    return corruptManagedSessionRecord(sessionId, "record.tag.sessionName must be a non-empty string");
  }
  if (
    tag.scope !== "orchestrator" &&
    tag.scope !== "worker" &&
    tag.scope !== "bridge"
  ) {
    return corruptManagedSessionRecord(sessionId, "record.tag.scope must be orchestrator|worker|bridge");
  }
  if (
    tag.origin !== "start.sh" &&
    tag.origin !== "ao-spawn-with-moltzap.ts" &&
    tag.origin !== "webhook-bridge.ts"
  ) {
    return corruptManagedSessionRecord(sessionId, "record.tag.origin must be a managed lifecycle origin");
  }
  if (typeof tag.claimedAtMs !== "number" || Number.isNaN(tag.claimedAtMs)) {
    return corruptManagedSessionRecord(sessionId, "record.tag.claimedAtMs must be a number");
  }
  return ok({
    managed: true,
    owner: "zapbot",
    projectName: tag.projectName,
    sessionName: asAoSessionName(tag.sessionName),
    scope: tag.scope,
    origin: tag.origin,
    claimedAtMs: tag.claimedAtMs,
  });
}

function corruptManagedSessionRecord(
  sessionId: unknown,
  reason: string,
): Err<ManagedSessionRegistryError> {
  return err({
    _tag: "ManagedSessionRecordCorrupt",
    sessionId: asManagedSessionId(
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "unknown",
    ),
    reason,
  });
}

type Err<E> = Extract<Result<never, E>, { readonly _tag: "Err" }>;

function isManagedSessionPhase(value: unknown): value is ManagedSessionPhase {
  return (
    value === "claimed" ||
    value === "active" ||
    value === "draining" ||
    value === "stopped" ||
    value === "orphaned"
  );
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || (typeof value === "number" && !Number.isNaN(value));
}

function isNodeErrorCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
