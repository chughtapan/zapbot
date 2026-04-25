/**
 * orchestrator/runtime — ensure the persistent AO orchestrator exists and
 * forward control prompts into it.
 *
 * Also: construct a RosterManager bound to the AO CLI
 * (`createAoCliRosterManagerDeps` + `createRosterManager`) so callers
 * spawning worker sessions go through the roster manager's typed surface
 * instead of invoking `ao spawn` or `bin/ao-spawn-with-moltzap.ts` directly
 * (Invariants 3 and 4; architect plan #148 §2.7).
 */

import { spawn } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  closeBridgeSession,
  createBridgeSession,
  type BridgeSessionError,
} from "../moltzap/bridge-app.ts";
import {
  registerBridgeAgent,
  type BridgeRegistrationError,
} from "../moltzap/bridge-identity.ts";
import type { MoltzapRuntimeConfig } from "../moltzap/runtime.ts";
import type { MoltzapSenderId } from "../moltzap/types.ts";
import { asMoltzapSenderId } from "../moltzap/types.ts";
import type { AoSessionName, ProjectName, Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { OrchestratorControlPrompt } from "./control-event.ts";
import type {
  RosterId,
  RosterManager,
  RosterManagerDeps,
  RosterMember,
  RosterMemberSpec,
} from "./roster.ts";
import { asWallClockMs, asTokenCount } from "./budget.ts";
import type { TokenCount } from "./budget.ts";

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

/**
 * Run a bun script (currently `bin/ao-spawn-with-moltzap.ts`) with the
 * same env/timeout discipline as `runAoCommand`. Used by the roster
 * manager's spawnSession dep to go through the MoltZap bootstrap path
 * (architect plan §2.3) rather than invoking `ao spawn` directly.
 */
async function runBunScript(
  options: AoCliOptions,
  scriptPath: string,
  args: readonly string[],
  extraEnv: Record<string, string | undefined> = {},
): Promise<Result<SpawnResult, SpawnFailure>> {
  const env = {
    ...buildCliEnv(options.env ?? process.env, options.configPath),
    ...extraEnv,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bun = normalizeEnvValue(env.BUN_BINARY) ?? "bun";
  return await new Promise((resolve) => {
    const child = spawn(bun, ["run", scriptPath, ...args], {
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
      child.stdout.on("data", (c) => {
        stdout += String(c);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => {
        stderr += String(c);
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
          cause: `bun run ${scriptPath} timed out after ${timeoutMs}ms`,
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
    const found = sessions.value.find((session) => isOrchestratorSession(session, projectName));
    if (!found) {
      return err({ _tag: "OrchestratorNotFound", projectName });
    }
    const name = found.name ?? found.id ?? sessionNameFor(projectName);
    if (isNotReadyStatus(found.status)) {
      return err({
        _tag: "OrchestratorNotReady",
        projectName,
        reason: `orchestrator session ${name} is ${found.status ?? "not ready"}`,
      });
    }
    return ok({
      session: name as AoSessionName,
      senderId: resolveSenderId(projectName, found),
      mode: found.status ? "reused" : "started",
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
      try {
        unlinkSync(tempFile);
      } catch {
        // best effort cleanup
      }
    }
  }

  return {
    ensureStarted,
    resolveReady: resolveReadySession,
    sendPrompt,
  };
}

// ── RosterManagerDeps factory (architect plan §2.7) ───────────────
//
// Bind the typed RosterManager interface to the AO CLI. `spawnSession`
// mints the worker's MoltZap creds + admits them to bridge-owned
// conversations via `createBridgeSession({invitedAgentIds:[senderId]})`
// BEFORE invoking `bun run bin/ao-spawn-with-moltzap.ts`, so the worker
// boots on the pre-minted-credentials path (sbd#201 + architect rev 4
// §4.3). `retireSession` issues `ao kill`. `clock` defaults to
// `Date.now`.
//
// Callers: `createRosterManager(createAoCliRosterManagerDeps(opts, {...}))`.

export interface AoCliRosterManagerOptions {
  /**
   * Orchestrator sender identity. Recorded on every spawned member so
   * downstream callers can route worker-to-orchestrator messages back to
   * a known endpoint.
   */
  readonly orchestratorSenderId: MoltzapSenderId;
  /**
   * MoltZap auth used to mint per-worker credentials BEFORE spawn
   * (architect rev 4 §4.3). When set, the spawn dep mints creds via
   * `registerBridgeAgent`, admits via `createBridgeSession`, and passes
   * `MOLTZAP_AGENT_KEY` + `MOLTZAP_LOCAL_SENDER_ID` to the wrapper so
   * the worker boots on the pre-minted-credentials path. `null` short-
   * circuits to the worker self-register flow (transitional, sbd#205).
   */
  readonly moltzapAuth: Extract<MoltzapRuntimeConfig, { readonly _tag: "MoltzapRegistration" }> | null;
}

/**
 * Bridge-side coordinator that folds MoltZap ingress events + an
 * interval tick into the RosterManager's budget state machine. This is
 * the production wiring point for SPEC §5(g) code-level enforcement:
 * the coordinator converts raw inbound events (from
 * `src/moltzap/bridge.ts` onInbound) into `recordPeerMessageObserved`
 * + `stepBudget` calls, and runs `stepBudget` on a timer so gates
 * trip even without fresh events.
 *
 * Instantiated once per bridge boot, alongside `aoControlHost`.
 */
export interface RosterBudgetCoordinator {
  readonly observeInboundPeerMessage: (args: {
    readonly session: AoSessionName;
    readonly atMs: number;
  }) => void;
  readonly observeTokensConsumed: (args: {
    readonly session: AoSessionName;
    readonly tokens: number;
  }) => void;
  readonly tickAllBudgets: (nowMs?: number) => Promise<readonly RosterBudgetTickOutcome[]>;
  readonly startPeriodicTick: (intervalMs: number) => () => void;
}

export interface RosterBudgetTickOutcome {
  readonly rosterId: RosterId;
  readonly outcomeTag: string;
}

export function createRosterBudgetCoordinator(
  manager: RosterManager,
  nowFn: () => number = Date.now,
): RosterBudgetCoordinator {
  function observeInboundPeerMessage(args: {
    readonly session: AoSessionName;
    readonly atMs: number;
  }): void {
    const rosterId = manager.findRosterForSession(args.session);
    if (rosterId === null) return;
    // Fire-and-forget: the state fold is synchronous; errors only
    // surface as RosterNotFound (which we just excluded).
    manager.recordPeerMessageObserved(
      rosterId,
      args.session,
      asWallClockMs(args.atMs),
    );
  }

  function observeTokensConsumed(args: {
    readonly session: AoSessionName;
    readonly tokens: number;
  }): void {
    const rosterId = manager.findRosterForSession(args.session);
    if (rosterId === null) return;
    const tokens: TokenCount = asTokenCount(Math.max(0, Math.floor(args.tokens)));
    manager.recordTokensConsumed(rosterId, args.session, tokens);
  }

  async function tickAllBudgets(
    nowMs?: number,
  ): Promise<readonly RosterBudgetTickOutcome[]> {
    const t = asWallClockMs(nowMs ?? nowFn());
    const ids = manager.listActiveRosterIds();
    // Rosters are independent; step in parallel so a single slow
    // retireSession on one roster doesn't block the others.
    const outcomes = await Promise.all(
      ids.map(async (rosterId) => {
        const outcome = await manager.stepBudget(rosterId, t);
        return { rosterId, outcomeTag: outcome._tag };
      }),
    );
    return outcomes;
  }

  function startPeriodicTick(intervalMs: number): () => void {
    const handle = setInterval(() => {
      // Fire-and-forget; errors inside are already typed into
      // BudgetStepOutcome.StepFailed.
      void tickAllBudgets();
    }, intervalMs);
    return () => clearInterval(handle);
  }

  return {
    observeInboundPeerMessage,
    observeTokensConsumed,
    tickAllBudgets,
    startPeriodicTick,
  };
}

/**
 * Internal failure cause for the prepare/spawn pipeline. Public API
 * (`MemberSpawnFailed.cause: string`) is preserved by stringifying at the
 * boundary; the typed union lives module-locally so rollback paths and
 * `console.warn` diagnostics keep operator-actionable detail
 * (HTTP status + body for registration, `_tag` + agentId for admission)
 * without widening the caller-facing surface (codex stamina round-1 P2).
 */
type SpawnFailureCause =
  | { readonly _tag: "RegistrationFailed"; readonly cause: BridgeRegistrationError }
  | { readonly _tag: "BridgeSessionFailed"; readonly cause: BridgeSessionError }
  | { readonly _tag: "RosterContextMissing"; readonly rosterId: RosterId }
  | { readonly _tag: "SpawnProcessFailed"; readonly stderr: string; readonly exitCode: number | null; readonly cause: string }
  | { readonly _tag: "SpawnStdoutMalformed"; readonly stdout: string };

function describeRegistrationError(error: BridgeRegistrationError): string {
  switch (error._tag) {
    case "BridgeRegistrationHttpFailed":
      return `${error._tag} (status=${error.status}, body=${error.body.slice(0, 200)})`;
    case "BridgeRegistrationDecodeFailed":
      return `${error._tag} (${error.reason})`;
  }
}

function describeBridgeSessionError(error: BridgeSessionError): string {
  switch (error._tag) {
    case "BridgeAppNotBooted":
      return error._tag;
    case "BridgeSessionCreateFailed":
      return `${error._tag} (${error.cause.message})`;
    case "BridgeSessionAdmissionTimeout":
      return `${error._tag} (sessionId=${error.sessionId}, waitedMs=${error.waitedMs})`;
    case "BridgeSessionAdmissionRejected":
      return `${error._tag} (sessionId=${error.sessionId}, agentId=${error.agentId}, reason=${error.reason})`;
  }
}

function describeSpawnFailure(cause: SpawnFailureCause): string {
  switch (cause._tag) {
    case "RegistrationFailed":
      return `worker registration failed: ${describeRegistrationError(cause.cause)}`;
    case "BridgeSessionFailed":
      return `bridge session failed: ${describeBridgeSessionError(cause.cause)}`;
    case "RosterContextMissing":
      return `roster session not prepared for ${cause.rosterId as string}`;
    case "SpawnProcessFailed":
      return cause.stderr.trim().length > 0 ? cause.stderr.trim() : cause.cause;
    case "SpawnStdoutMalformed":
      return `could not parse SESSION= from ao-spawn-with-moltzap stdout: ${cause.stdout.trim()}`;
  }
}

/**
 * Transitional path (sbd#205 deletes this). When the orchestrator did not
 * pre-mint creds, parse the worker's self-registered MOLTZAP_LOCAL_SENDER_ID
 * from the wrapper's stdout. Fall back to a derived id with a diagnostic
 * when the line is missing.
 */
function resolveSelfRegisteredSenderId(
  stdout: string,
  rosterId: RosterId,
  displayLabel: string,
  sessionName: AoSessionName,
): MoltzapSenderId {
  const senderMatch = stdout.match(/MOLTZAP_LOCAL_SENDER_ID=([^\s]+)/);
  if (senderMatch && senderMatch[1]) {
    return asMoltzapSenderId(senderMatch[1]);
  }
  const fallback = asMoltzapSenderId(`${rosterId as string}-${displayLabel}`);
  console.warn(
    `[roster] worker ${sessionName as string} spawn stdout did not include MOLTZAP_LOCAL_SENDER_ID; using derived fallback (${fallback as string}).`,
  );
  return fallback;
}

/**
 * Per-roster state held inside the deps closure. Architect rev 4 §4.3
 * model: ONE bridge session per roster, invited = union of all worker
 * senderIds. The session lifetime tracks the roster's, not the per-
 * worker session's; `retireSession` releases the worker process and
 * drops the `rosterIdBySession` entry, but does NOT close the bridge
 * session. `releaseRosterSession` closes the bridge session and removes
 * this entry — invoked by the roster manager after a failed-spawn
 * rollback or after the last member is retired.
 */
interface RosterContext {
  readonly bridgeSessionId: string | null;
  readonly premintedByLabel: ReadonlyMap<
    string,
    { readonly agentKey: string; readonly senderId: MoltzapSenderId }
  >;
}

export function createAoCliRosterManagerDeps(
  options: AoCliOptions,
  rosterOptions: AoCliRosterManagerOptions,
): RosterManagerDeps {
  const rosterContexts = new Map<RosterId, RosterContext>();
  // Inverted index: session → owning roster. Maintained in lockstep with
  // worker spawn/retire so `retireSession` finds its roster in O(1) and
  // `releaseRoster` can defensively drain leftover entries (e.g. after
  // partial-rollback paths) without an extra structure.
  const rosterIdBySession = new Map<string, RosterId>();

  /**
   * Architect rev 4 §4.3 prepare phase — register all worker creds and
   * create ONE bridge session whose `invitedAgentIds` is the union of
   * worker senderIds. Codex stamina round-1 P1 #1 fix: per-spawn was
   * structurally wrong because conversations are session-scoped, so
   * workers in different sessions could not exchange messages on shared
   * `coord-*` conversation keys.
   */
  async function prepareRoster(
    rosterId: RosterId,
    members: readonly RosterMemberSpec[],
  ): Promise<Result<void, SpawnFailureCause>> {
    const auth = rosterOptions.moltzapAuth;
    if (auth === null) {
      // Transitional path (sbd#205): no creds minted, no bridge session.
      // Still install an empty roster context so spawnSession +
      // retireSession can route by rosterId without conditional logic.
      rosterContexts.set(rosterId, {
        bridgeSessionId: null,
        premintedByLabel: new Map(),
      });
      return ok(undefined);
    }

    // Register every worker before the single createBridgeSession call.
    // Workers are independent → run in parallel; first-failure-wins via
    // Promise.all (rejects-on-first-reject). Earlier successful
    // registrations on a failure path become server-side dead agents,
    // which is the same shape as the prior per-spawn implementation.
    const registrations = await Promise.all(
      members.map(async (member) => {
        const displayName = `${rosterId as string}-${member.displayLabel}`.slice(
          0,
          32,
        );
        const registration = await registerBridgeAgent({
          serverUrl: auth.serverUrl,
          registrationSecret: auth.registrationSecret,
          displayName,
        });
        return { member, registration };
      }),
    );
    const premintedByLabel = new Map<
      string,
      { readonly agentKey: string; readonly senderId: MoltzapSenderId }
    >();
    for (const { member, registration } of registrations) {
      if (registration._tag === "Err") {
        return err({
          _tag: "RegistrationFailed",
          cause: registration.error,
        });
      }
      premintedByLabel.set(member.displayLabel, {
        agentKey: registration.value.agentKey,
        senderId: asMoltzapSenderId(registration.value.agentId as string),
      });
    }

    const allSenderIds = [...premintedByLabel.values()].map((v) => v.senderId);
    const sessionResult = await Effect.runPromise(
      createBridgeSession({ invitedAgentIds: allSenderIds }).pipe(Effect.either),
    );
    if (sessionResult._tag === "Left") {
      return err({
        _tag: "BridgeSessionFailed",
        cause: sessionResult.left,
      });
    }

    rosterContexts.set(rosterId, {
      bridgeSessionId: sessionResult.right.sessionId,
      premintedByLabel,
    });
    return ok(undefined);
  }

  async function releaseRoster(rosterId: RosterId): Promise<void> {
    const ctx = rosterContexts.get(rosterId);
    if (ctx === undefined) return;
    // Close FIRST, then delete the context entry on success. If close
    // fails, leave the context intact so a SIGTERM drain (or a follow-up
    // releaseRosterSession call) can retry.
    if (ctx.bridgeSessionId !== null && ctx.bridgeSessionId !== "") {
      const closeResult = await Effect.runPromise(
        closeBridgeSession(ctx.bridgeSessionId).pipe(Effect.either),
      );
      if (closeResult._tag === "Left") {
        console.warn(
          `[roster] releaseRosterSession: closeBridgeSession failed for roster ${rosterId as string} (${closeResult.left._tag}); will retry on SIGTERM drain.`,
        );
        return;
      }
    }
    // Defensive sweep: drop any session→roster entries still pointing at
    // this rosterId. retireSession normally clears them, but partial
    // rollbacks can leave dirty entries when ao kill failed mid-cleanup.
    for (const [session, owner] of [...rosterIdBySession]) {
      if (owner === rosterId) rosterIdBySession.delete(session);
    }
    rosterContexts.delete(rosterId);
  }

  return {
    prepareRosterSession: async ({ rosterId, members }) => {
      // Idempotency-by-prevention: prepare should only run once per
      // rosterId. The roster manager calls prepare exactly once per
      // spawnRoster, but a retry-after-failure could land here twice;
      // surface the duplicate as a stable error rather than silently
      // overwriting state and orphaning the prior bridge session.
      if (rosterContexts.has(rosterId)) {
        return err({
          _tag: "RosterSessionPrepareFailed",
          cause: `roster ${rosterId as string} already prepared`,
        });
      }
      const result = await prepareRoster(rosterId, members);
      if (result._tag === "Err") {
        return err({
          _tag: "RosterSessionPrepareFailed",
          cause: describeSpawnFailure(result.error),
        });
      }
      return ok(undefined);
    },
    spawnSession: async ({ rosterId, member, issue, projectName }) => {
      // Sentinel-marked reserved-key collision: if the caller passed a
      // displayLabel that starts with "moltzap", reject it with the
      // ReservedMcpKeyCollision error tag (Invariant 4). The label becomes
      // part of the mcpServers key downstream; "moltzap" is reserved for
      // the zapbot-authored entry.
      if (
        member.displayLabel === "moltzap" ||
        member.displayLabel.startsWith("moltzap-reserved-")
      ) {
        return err({
          _tag: "ReservedMcpKeyCollision",
          key: "moltzap",
          member: { role: member.role, displayLabel: member.displayLabel },
        });
      }

      const memberFail = (cause: SpawnFailureCause) =>
        err({
          _tag: "MemberSpawnFailed" as const,
          role: member.role,
          displayLabel: member.displayLabel,
          cause: describeSpawnFailure(cause),
        });

      const ctx = rosterContexts.get(rosterId);
      if (ctx === undefined) {
        return memberFail({ _tag: "RosterContextMissing", rosterId });
      }

      const prompt = [
        `This session is a WS2 roster member for project `
          + `${projectName as string}, roster ${rosterId as string}, `
          + `sub-issue #${issue as number}, role ${member.role}, `
          + `label ${member.displayLabel}. Read the roster sub-issue body for `
          + `your acceptance criteria and publish durable artifacts to GitHub.`,
      ].join("\n");

      const preminted = ctx.premintedByLabel.get(member.displayLabel) ?? null;
      const extraEnv: Record<string, string | undefined> =
        preminted !== null
          ? {
              MOLTZAP_AGENT_KEY: preminted.agentKey,
              MOLTZAP_LOCAL_SENDER_ID: preminted.senderId as string,
            }
          : {};
      const spawnResult = await runBunScript(
        options,
        "bin/ao-spawn-with-moltzap.ts",
        [
          "--prompt",
          prompt,
          "--role",
          member.role,
          "--label",
          member.displayLabel,
          "--project",
          projectName as string,
        ],
        extraEnv,
      );
      if (spawnResult._tag === "Err") {
        return memberFail({
          _tag: "SpawnProcessFailed",
          stderr: spawnResult.error.stderr,
          exitCode: spawnResult.error.exitCode,
          cause: spawnResult.error.cause,
        });
      }
      // The wrapper writes `SESSION=<name>` on success. If the format drifts
      // we fail loudly rather than fabricate: a wrong session name leaves
      // the RosterManager tracking a ghost and every later retireSession
      // fails on a name that was never spawned.
      const stdout = spawnResult.value.stdout;
      const match = stdout.match(/SESSION=([^\s]+)/);
      if (!match || !match[1]) {
        return memberFail({ _tag: "SpawnStdoutMalformed", stdout });
      }
      const sessionName = match[1] as AoSessionName;
      const senderId =
        preminted !== null
          ? preminted.senderId
          : resolveSelfRegisteredSenderId(stdout, rosterId, member.displayLabel, sessionName);
      rosterIdBySession.set(sessionName as string, rosterId);
      const rosterMember: RosterMember = {
        rosterId,
        session: sessionName,
        senderId,
        role: member.role,
        displayLabel: member.displayLabel,
        spawnedAtMs: Date.now(),
      };
      return ok(rosterMember);
    },
    retireSession: async (session) => {
      // Per-roster session model: retireSession only takes the worker
      // process down (`ao kill`) and drops the session→roster mapping.
      // The bridge session itself lives until `releaseRosterSession` is
      // invoked by the roster manager — architect rev 4 §4.3 lifetime
      // contract — which is also where the close-before-delete-on-success
      // ordering is enforced.
      rosterIdBySession.delete(session as string);
      const killResult = await runAoCommand(options, [
        "kill",
        session as string,
      ]);
      if (killResult._tag === "Err") {
        return err({
          _tag: "RetireReleaseFailed",
          cause:
            killResult.error.stderr.trim().length > 0
              ? killResult.error.stderr.trim()
              : killResult.error.cause,
        });
      }
      return ok(undefined);
    },
    releaseRosterSession: releaseRoster,
    clock: () => Date.now(),
  };
}
