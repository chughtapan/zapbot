/**
 * moltzap/runtime — zapbot-side MoltZap config + session provisioning.
 *
 * Anchors: sbd#170 SPEC rev 2, §8 "preserved modules"; Invariants 3, 4.
 *
 * This module owns two boundaries only:
 *   1. Decode zapbot env/config into a typed MoltZap runtime config.
 *   2. Materialize the `MOLTZAP_*` env a spawned `ao` session should receive.
 *
 * Per spec rev 2 §3 Non-goal 4, the `MoltzapStatic` variant is removed; only
 * `MoltzapDisabled` and `MoltzapRegistration` remain. Per Invariant 4, the
 * registration secret is NEVER materialized into a worker's spawn env — the
 * bridge mints per-session agent credentials via `POST /api/v1/auth/register`
 * and hands the worker ONLY its minted `apiKey`.
 *
 * Per spec §5, sender-admission via `MOLTZAP_ALLOWED_SENDERS` is also
 * removed: admission is server-enforced via `AppManifest.participantFilter`
 * + `permissions`. The spawn env no longer carries an allowlist CSV.
 */

import { absurd, err, ok } from "../types.ts";
import type {
  AoSessionName,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "../types.ts";

export interface MoltzapSpawnContext {
  readonly repo: RepoFullName;
  readonly issue: IssueNumber;
  readonly projectName: ProjectName;
  readonly session: AoSessionName;
}

/**
 * Env vars that MUST be scrubbed from any worker-side child process env
 * (both initial spawn and resume paths in `bin/ao-spawn-with-moltzap.ts`).
 *
 * Anchors: SPEC rev 2 Invariant 4 (registration secret never reaches a
 * worker) and §5 (allowlist env removed; server-side admission).
 *
 * Lifted into this module so the bin wrapper and
 * `test/moltzap-runtime.test.ts` iterate the same constant — the
 * reviewer-328 drift concern: "the scrub list will silently drift the
 * next time a secret env is added."
 */
export const MOLTZAP_WORKER_FORBIDDEN_ENV: readonly string[] = [
  "MOLTZAP_REGISTRATION_SECRET",
  "ZAPBOT_MOLTZAP_REGISTRATION_SECRET",
  "MOLTZAP_ALLOWED_SENDERS",
  "ZAPBOT_MOLTZAP_ALLOWED_SENDERS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
];

/**
 * Mutate `env` in place to drop every key in `MOLTZAP_WORKER_FORBIDDEN_ENV`.
 * Callers on the worker-spawn path (both initial spawn and resume restart)
 * must run this after `...process.env` is spread in so no ambient parent
 * value leaks to the worker.
 */
export function scrubMoltzapForbiddenEnv(env: Record<string, string>): void {
  for (const name of MOLTZAP_WORKER_FORBIDDEN_ENV) {
    delete env[name];
  }
}

export type MoltzapRuntimeConfig =
  | { readonly _tag: "MoltzapDisabled" }
  | {
      readonly _tag: "MoltzapRegistration";
      readonly serverUrl: string;
      readonly registrationSecret: string;
    };

export type MoltzapConfigError = {
  readonly _tag: "MoltzapConfigInvalid";
  readonly reason: string;
};

export type MoltzapProvisionError = {
  readonly _tag: "MoltzapProvisionFailed";
  readonly cause: string;
};

export function loadMoltzapRuntimeConfig(
  env: Record<string, string | undefined>,
): Result<MoltzapRuntimeConfig, MoltzapConfigError> {
  const serverUrl = normalizeEnvVar(env.ZAPBOT_MOLTZAP_SERVER_URL);
  const registrationSecret = normalizeEnvVar(
    env.ZAPBOT_MOLTZAP_REGISTRATION_SECRET,
  );
  const legacyApiKey = normalizeEnvVar(env.ZAPBOT_MOLTZAP_API_KEY);

  if (serverUrl === null) {
    if (registrationSecret !== null || legacyApiKey !== null) {
      return err({
        _tag: "MoltzapConfigInvalid",
        reason:
          "ZAPBOT_MOLTZAP_SERVER_URL is required when MoltZap auth is configured.",
      });
    }
    return ok({ _tag: "MoltzapDisabled" });
  }

  if (legacyApiKey !== null && registrationSecret === null) {
    return err({
      _tag: "MoltzapConfigInvalid",
      reason:
        "ZAPBOT_MOLTZAP_API_KEY (MoltzapStatic) is deprecated by spec rev 2; set ZAPBOT_MOLTZAP_REGISTRATION_SECRET instead.",
    });
  }

  if (registrationSecret === null) {
    return err({
      _tag: "MoltzapConfigInvalid",
      reason:
        "Set ZAPBOT_MOLTZAP_REGISTRATION_SECRET when ZAPBOT_MOLTZAP_SERVER_URL is configured.",
    });
  }

  return ok({
    _tag: "MoltzapRegistration",
    serverUrl,
    registrationSecret,
  });
}

export async function buildMoltzapSpawnEnv(
  config: MoltzapRuntimeConfig,
  ctx: MoltzapSpawnContext,
): Promise<Result<Record<string, string>, MoltzapProvisionError>> {
  switch (config._tag) {
    case "MoltzapDisabled":
      return ok({});
    case "MoltzapRegistration":
      return registerSessionAgent(config, ctx);
    default:
      return absurd(config);
  }
}

/**
 * Materialize the MoltZap-related parent-process env that the bridge's own
 * boot inherits. This is the BRIDGE process env — it legitimately carries
 * `MOLTZAP_REGISTRATION_SECRET` because the bridge is the only process that
 * calls `POST /auth/register` to mint worker credentials.
 *
 * Workers receive their env from `buildMoltzapSpawnEnv` (no secret).
 */
export function buildMoltzapProcessEnv(
  config: MoltzapRuntimeConfig,
): Record<string, string> {
  switch (config._tag) {
    case "MoltzapDisabled":
      return {};
    case "MoltzapRegistration":
      return {
        MOLTZAP_SERVER_URL: config.serverUrl,
        MOLTZAP_REGISTRATION_SECRET: config.registrationSecret,
      };
    default:
      return absurd(config);
  }
}

interface RegistrationResponse {
  readonly apiKey: string;
  readonly agentId: string;
}

async function registerSessionAgent(
  config: Extract<MoltzapRuntimeConfig, { readonly _tag: "MoltzapRegistration" }>,
  ctx: MoltzapSpawnContext,
): Promise<Result<Record<string, string>, MoltzapProvisionError>> {
  const agentName = buildAgentName(ctx);
  let response: Response;
  try {
    response = await fetch(`${toHttpBaseUrl(config.serverUrl)}/api/v1/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: agentName,
        description: `zapbot ao session ${ctx.session as unknown as string}`,
        inviteCode: config.registrationSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    return err({
      _tag: "MoltzapProvisionFailed",
      cause: `registration request failed: ${stringifyCause(cause)}`,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return err({
      _tag: "MoltzapProvisionFailed",
      cause: `registration failed (${response.status}): ${body || "empty response"}`,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    return err({
      _tag: "MoltzapProvisionFailed",
      cause: `registration returned invalid JSON: ${stringifyCause(cause)}`,
    });
  }

  const decoded = decodeRegistrationResponse(payload);
  if (decoded === null) {
    return err({
      _tag: "MoltzapProvisionFailed",
      cause: "registration response missing string apiKey or agentId.",
    });
  }

  return ok(toSpawnEnv(config.serverUrl, decoded.apiKey, decoded.agentId));
}

function decodeRegistrationResponse(
  payload: unknown,
): { readonly apiKey: string; readonly agentId: string } | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const apiKey = (payload as RegistrationResponse).apiKey;
  const agentId = (payload as RegistrationResponse).agentId;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return null;
  }
  if (typeof agentId !== "string" || agentId.length === 0) {
    return null;
  }
  return { apiKey, agentId };
}

function toSpawnEnv(
  serverUrl: string,
  apiKey: string,
  localSenderId: string,
): Record<string, string> {
  return {
    MOLTZAP_SERVER_URL: serverUrl,
    MOLTZAP_API_KEY: apiKey,
    MOLTZAP_LOCAL_SENDER_ID: localSenderId,
  };
}

function normalizeEnvVar(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toHttpBaseUrl(serverUrl: string): string {
  return serverUrl
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/+$/, "");
}

function buildAgentName(ctx: MoltzapSpawnContext): string {
  const raw =
    `zb-${ctx.projectName as unknown as string}-${ctx.issue}-${shortSuffix()}`.toLowerCase();
  const sanitized = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  const maxLength = 32;
  const trimmed = sanitized.slice(0, maxLength).replace(/[^a-z0-9]+$/, "");
  if (trimmed.length >= 3 && /^[a-z0-9]/.test(trimmed) && /[a-z0-9]$/.test(trimmed)) {
    return trimmed;
  }
  return `zb-${shortSuffix()}`;
}

function shortSuffix(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1_679_616).toString(36)}`.slice(
    -6,
  );
}

function stringifyCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
