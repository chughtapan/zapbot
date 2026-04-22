/**
 * orchestrator/runtime — ensure the persistent AO orchestrator exists and
 * forward control prompts into it.
 */

import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createManagedSessionFileRegistry,
  isManagedSessionRecord,
  managedSessionIdFromSessionName,
  resolveManagedSessionRegistryPath,
  type ManagedSessionRegistryError,
  type ManagedSessionRecord,
} from "../lifecycle/contracts.ts";
import type { MoltzapSenderId } from "../moltzap/types.ts";
import { asMoltzapSenderId } from "../moltzap/types.ts";
import type { AoSessionName, ProjectName, Result } from "../types.ts";
import { asAoSessionName, err, ok } from "../types.ts";
import type { OrchestratorControlPrompt } from "./control-event.ts";

export interface OrchestratorReady {
  readonly session: AoSessionName;
  readonly senderId: MoltzapSenderId;
  readonly mode: "reused" | "started";
}

export interface OrchestratorForwardReceipt {
  readonly session: AoSessionName;
  readonly senderId: MoltzapSenderId;
}

export type AoControlHostError =
  | { readonly _tag: "AoStartFailed"; readonly cause: string }
  | { readonly _tag: "OrchestratorNotFound"; readonly projectName: ProjectName }
  | { readonly _tag: "OrchestratorNotReady"; readonly projectName: ProjectName; readonly reason: string }
  | { readonly _tag: "AoSendFailed"; readonly cause: string };

export interface AoControlHost {
  readonly ensureStarted: (
    projectName: ProjectName,
  ) => Promise<Result<void, Extract<AoControlHostError, { readonly _tag: "AoStartFailed" }>>>;
  readonly resolveReady: (
    projectName: ProjectName,
  ) => Promise<
    Result<
      OrchestratorReady,
      | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotFound" }>
      | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotReady" }>
    >
  >;
  readonly sendPrompt: (
    session: AoSessionName,
    prompt: OrchestratorControlPrompt,
  ) => Promise<Result<void, Extract<AoControlHostError, { readonly _tag: "AoSendFailed" }>>>;
}

export type EnsureOrchestratorError =
  | Extract<AoControlHostError, { readonly _tag: "AoStartFailed" }>
  | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotFound" }>
  | Extract<AoControlHostError, { readonly _tag: "OrchestratorNotReady" }>;

export type ForwardControlError = EnsureOrchestratorError | Extract<AoControlHostError, { readonly _tag: "AoSendFailed" }>;

/**
 * Ensure the persistent per-project orchestrator session exists and has a
 * discoverable MoltZap identity before any control prompt is forwarded.
 */
export async function ensureProjectOrchestrator(
  projectName: ProjectName,
  host: AoControlHost,
): Promise<Result<OrchestratorReady, EnsureOrchestratorError>> {
  const started = await host.ensureStarted(projectName);
  if (started._tag === "Err") {
    return err(started.error);
  }
  const ready = await host.resolveReady(projectName);
  if (ready._tag === "Err") {
    return err(ready.error);
  }
  return ok(ready.value);
}

/**
 * Deliver a rendered control prompt into the ready orchestrator session.
 */
export async function forwardControlPrompt(
  projectName: ProjectName,
  prompt: OrchestratorControlPrompt,
  host: AoControlHost,
): Promise<Result<OrchestratorForwardReceipt, ForwardControlError>> {
  const ready = await ensureProjectOrchestrator(projectName, host);
  if (ready._tag === "Err") {
    return ready;
  }
  const sent = await host.sendPrompt(ready.value.session, prompt);
  if (sent._tag === "Err") {
    return err(sent.error);
  }
  return ok({
    session: ready.value.session,
    senderId: ready.value.senderId,
  });
}

interface AoCliOptions {
  readonly aoBinary?: string;
  readonly configPath: string | null;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

interface AoStatusSession {
  readonly id?: string;
  readonly name?: string;
  readonly role?: string;
  readonly status?: string;
  readonly metadata?: Record<string, unknown>;
}

interface SpawnFailure {
  readonly cause: string;
  readonly exitCode: number | null;
  readonly stderr: string;
}

interface SpawnResult {
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const STARTING_STATUSES = new Set(["starting", "initializing", "provisioning", "booting"]);

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildCliEnv(base: Record<string, string | undefined>, configPath: string | null): Record<string, string | undefined> {
  const env = { ...base };
  if (configPath) {
    env.AO_CONFIG_PATH = configPath;
  }
  return env;
}

function aoBinaryPath(options: AoCliOptions): string {
  return options.aoBinary ?? normalizeEnvValue(process.env.AO_BINARY) ?? "ao";
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAoCommand(
  options: AoCliOptions,
  args: readonly string[],
): Promise<Result<SpawnResult, SpawnFailure>> {
  const env = buildCliEnv(options.env ?? process.env, options.configPath);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ao = aoBinaryPath(options);
  return await new Promise((resolve) => {
    const child = spawn(ao, [...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }
    child.once("error", (error) => {
      clearTimeout(timeout);
      resolve(err({
        cause: error instanceof Error ? error.message : String(error),
        exitCode: null,
        stderr,
      }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        resolve(err({
          cause: `ao ${args.join(" ")} timed out after ${timeoutMs}ms`,
          exitCode: null,
          stderr,
        }));
        return;
      }
      if (signal !== null || code !== 0) {
        resolve(err({
          cause: signal !== null ? `terminated by ${signal}` : `exit ${code ?? 0}`,
          exitCode: code ?? null,
          stderr,
        }));
        return;
      }
      resolve(ok({ stdout, stderr }));
    });
  });
}

function parseStatusSessions(output: string): Result<readonly AoStatusSession[], { readonly reason: string }> {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) {
      return err({ reason: "status output was not an array" });
    }
    return ok(parsed as readonly AoStatusSession[]);
  } catch (error) {
    return err({
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function sessionNameFor(projectName: ProjectName): string {
  return `${projectName as string}-orchestrator`;
}

function isOrchestratorSession(session: AoStatusSession, projectName: ProjectName): boolean {
  const name = session.name ?? session.id ?? "";
  if (session.role === "orchestrator") {
    return true;
  }
  const prefix = projectName as string;
  return name === `${prefix}-orchestrator` || /^.+-orchestrator-\d+$/.test(name) || name.endsWith("-orchestrator");
}

function isNotReadyStatus(status: string | undefined): boolean {
  if (typeof status !== "string") return false;
  return STARTING_STATUSES.has(status.trim().toLowerCase());
}

function resolveSenderId(projectName: ProjectName, session: AoStatusSession): MoltzapSenderId {
  const raw =
    normalizeEnvValue(session.metadata?.senderId as string | undefined) ??
    normalizeEnvValue(session.metadata?.localSenderId as string | undefined) ??
    normalizeEnvValue(process.env.MOLTZAP_ORCHESTRATOR_SENDER_ID) ??
    sessionNameFor(projectName);
  return asMoltzapSenderId(raw);
}

function formatPrompt(prompt: OrchestratorControlPrompt): string {
  return [`# ${prompt.title}`, "", prompt.body].join("\n");
}

/**
 * Concrete AO CLI-backed control host.
 */
export function createAoCliControlHost(options: AoCliOptions): AoControlHost {
  async function listProjectSessions(
    projectName: ProjectName,
  ): Promise<Result<readonly AoStatusSession[], Extract<AoControlHostError, { readonly _tag: "OrchestratorNotReady" }>>> {
    const result = await runAoCommand(options, ["status", "--project", projectName as string, "--json"]);
    if (result._tag === "Err") {
      return err({
        _tag: "OrchestratorNotReady",
        projectName,
        reason: result.error.stderr.trim().length > 0 ? result.error.stderr.trim() : result.error.cause,
      });
    }
    const parsed = parseStatusSessions(result.value.stdout);
    if (parsed._tag === "Err") {
      return err({
        _tag: "OrchestratorNotReady",
        projectName,
        reason: parsed.error.reason,
      });
    }
    return ok(parsed.value);
  }

  async function resolveReadySession(
    projectName: ProjectName,
  ): Promise<Result<OrchestratorReady, Extract<AoControlHostError, { readonly _tag: "OrchestratorNotFound" } | { readonly _tag: "OrchestratorNotReady" }>>> {
    const sessions = await listProjectSessions(projectName);
    if (sessions._tag === "Err") {
      return err(sessions.error);
    }
    const registry = createManagedSessionFileRegistry({
      registryPath: resolveManagedSessionRegistryPath({
        configPath: options.configPath,
      }),
    });
    const managed = await registry.listByProject(projectName);
    if (managed._tag === "Err") {
      return err({
        _tag: "OrchestratorNotReady",
        projectName,
        reason: stringifyRegistryError(managed.error),
      });
    }

    const found = resolveManagedOrchestratorSession(
      projectName,
      sessions.value,
      managed.value,
    );
    if (!found) {
      return err({ _tag: "OrchestratorNotFound", projectName });
    }
    if (isNotReadyStatus(found.session.status)) {
      return err({
        _tag: "OrchestratorNotReady",
        projectName,
        reason: `orchestrator session ${found.record.tag.sessionName as string} is ${found.session.status ?? "not ready"}`,
      });
    }
    return ok({
      session: found.record.tag.sessionName,
      senderId: resolveSenderId(projectName, found.session),
      mode: found.record.phase === "claimed" ? "started" : "reused",
    });
  }

  async function ensureStarted(
    projectName: ProjectName,
  ): Promise<Result<void, Extract<AoControlHostError, { readonly _tag: "AoStartFailed" }>>> {
    const started = await runAoCommand(options, ["start", projectName as string, "--no-dashboard"]);
    if (started._tag === "Err") {
      return err({
        _tag: "AoStartFailed",
        cause: started.error.stderr.trim().length > 0 ? started.error.stderr.trim() : started.error.cause,
      });
    }

    await claimManagedOrchestratorSession(projectName, options);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ready = await resolveReadySession(projectName);
      if (ready._tag === "Ok") {
        return ok(undefined);
      }
      if (ready.error._tag === "OrchestratorNotReady") {
        await sleep(250);
        continue;
      }
      await sleep(250);
    }
    return err({
      _tag: "AoStartFailed",
      cause: `orchestrator for ${projectName as string} did not become ready after ao start`,
    });
  }

  async function sendPrompt(
    session: AoSessionName,
    prompt: OrchestratorControlPrompt,
  ): Promise<Result<void, Extract<AoControlHostError, { readonly _tag: "AoSendFailed" }>>> {
    const tempFile = join(
      tmpdir(),
      `zapbot-ao-control-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    writeFileSync(tempFile, formatPrompt(prompt), "utf8");
    try {
      const sent = await runAoCommand(options, ["send", session as string, "--file", tempFile]);
      if (sent._tag === "Err") {
        return err({
          _tag: "AoSendFailed",
          cause: sent.error.stderr.trim().length > 0 ? sent.error.stderr.trim() : sent.error.cause,
        });
      }
      return ok(undefined);
    } finally {
      if (existsSync(tempFile)) {
        try {
          unlinkSync(tempFile);
        } catch {
          // best effort cleanup
        }
      }
    }
  }

  return {
    ensureStarted,
    resolveReady: resolveReadySession,
    sendPrompt,
  };
}

async function claimManagedOrchestratorSession(
  projectName: ProjectName,
  options: AoCliOptions,
): Promise<void> {
  const sessions = await runAoCommand(options, ["status", "--project", projectName as string, "--json"]);
  if (sessions._tag === "Err") {
    return;
  }
  const parsed = parseStatusSessions(sessions.value.stdout);
  if (parsed._tag === "Err") {
    return;
  }

  const statusSession = parsed.value.find((session) => isOrchestratorSession(session, projectName));
  if (statusSession === undefined) {
    return;
  }

  const sessionName = asAoSessionName(
    statusSession.name ?? statusSession.id ?? sessionNameFor(projectName),
  );
  const registry = createManagedSessionFileRegistry({
    registryPath: resolveManagedSessionRegistryPath({
      configPath: options.configPath,
    }),
  });
  await registry.put({
    id: managedSessionIdFromSessionName(sessionName),
    tag: {
      managed: true,
      owner: "zapbot",
      projectName,
      sessionName,
      scope: "orchestrator",
      origin: "start.sh",
      claimedAtMs: Date.now(),
    },
    tmuxName: statusSession.name ?? statusSession.id ?? null,
    worktree: null,
    processId: null,
    phase: "active",
    lastHeartbeatAtMs: Date.now(),
  });
}

function resolveManagedOrchestratorSession(
  projectName: ProjectName,
  sessions: readonly AoStatusSession[],
  managedRecords: ReadonlyArray<ManagedSessionRecord>,
): { readonly session: AoStatusSession; readonly record: ManagedSessionRecord } | null {
  const managed = managedRecords.filter(
    (record) =>
      isManagedSessionRecord(record) &&
      record.tag.projectName === projectName &&
      record.tag.scope === "orchestrator",
  );
  for (const record of managed) {
    const found = sessions.find((session) => matchesManagedSessionRecord(session, record));
    if (found !== undefined) {
      return {
        session: found,
        record,
      };
    }
  }
  return null;
}

function matchesManagedSessionRecord(
  session: AoStatusSession,
  record: ManagedSessionRecord,
): boolean {
  const name = session.name ?? session.id;
  if (typeof name !== "string" || name.length === 0) {
    return false;
  }
  return managedSessionIdFromSessionName(asAoSessionName(name)) === record.id;
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
