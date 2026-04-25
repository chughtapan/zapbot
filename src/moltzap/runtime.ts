/**
 * moltzap/runtime — zapbot-side MoltZap config + session provisioning.
 *
 * This module owns two boundaries only:
 *   1. Decode zapbot env/config into a typed MoltZap runtime config.
 *   2. Materialize the `MOLTZAP_*` env a spawned `ao` session should receive.
 *
 * Implementation lands in the implement-* phase. Architect stage exports the
 * public shape only.
 */

import { err, ok } from "../types.ts";
import type {
  AoSessionName,
  IssueNumber,
  ProjectName,
  RepoFullName,
  Result,
} from "../types.ts";
import { fromSenderIds, type SenderAllowlist } from "./identity-allowlist.ts";
import { asMoltzapSenderId } from "./types.ts";

export interface MoltzapSpawnContext {
  readonly repo: RepoFullName;
  readonly issue: IssueNumber;
  readonly projectName: ProjectName;
  readonly session: AoSessionName;
}

export type MoltzapRuntimeConfig =
  | { readonly _tag: "MoltzapDisabled" }
  | {
      readonly _tag: "MoltzapRegistration";
      readonly serverUrl: string;
      readonly registrationSecret: string;
      readonly allowlistCsv: string | null;
      readonly allowlist: SenderAllowlist;
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
  const registrationSecret = normalizeEnvVar(env.ZAPBOT_MOLTZAP_REGISTRATION_SECRET);
  const allowlistCsv = normalizeCsv(env.ZAPBOT_MOLTZAP_ALLOWED_SENDERS);
  const allowlist = fromSenderIds(parseAllowlist(allowlistCsv));

  if (serverUrl === null) {
    if (registrationSecret !== null) {
      return err({
        _tag: "MoltzapConfigInvalid",
        reason: "ZAPBOT_MOLTZAP_SERVER_URL is required when MoltZap auth is configured.",
      });
    }
    return ok({ _tag: "MoltzapDisabled" });
  }

  if (registrationSecret === null) {
    return err({
      _tag: "MoltzapConfigInvalid",
      reason:
        "ZAPBOT_MOLTZAP_REGISTRATION_SECRET is required when ZAPBOT_MOLTZAP_SERVER_URL is configured (rev 4 §8.1 path A — static MoltzapStatic variant removed).",
    });
  }

  return ok({
    _tag: "MoltzapRegistration",
    serverUrl,
    registrationSecret,
    allowlistCsv,
    allowlist,
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
 * Materialize the MoltZap-related parent-process env that `ao start` / `ao spawn`
 * should inherit before the session-local Claude channel server provisions its
 * own runtime identity.
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
        ...(config.allowlistCsv !== null
          ? { MOLTZAP_ALLOWED_SENDERS: config.allowlistCsv }
          : {}),
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

  const apiKey = decodeRegistrationResponse(payload);
  if (apiKey === null) {
    return err({
      _tag: "MoltzapProvisionFailed",
      cause: "registration response missing string apiKey or agentId.",
    });
  }

  return ok(
    toSpawnEnv(
      config.serverUrl,
      apiKey.apiKey,
      config.allowlistCsv,
      apiKey.agentId,
    ),
  );
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
  allowlistCsv: string | null,
  localSenderId?: string,
): Record<string, string> {
  const env: Record<string, string> = {
    MOLTZAP_SERVER_URL: serverUrl,
    MOLTZAP_API_KEY: apiKey,
  };
  if (typeof localSenderId === "string" && localSenderId.length > 0) {
    env.MOLTZAP_LOCAL_SENDER_ID = localSenderId;
  }
  if (allowlistCsv !== null) {
    env.MOLTZAP_ALLOWED_SENDERS = allowlistCsv;
  }
  return env;
}

function parseAllowlist(allowlistCsv: string | null) {
  if (allowlistCsv === null) return [];
  return allowlistCsv
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => asMoltzapSenderId(value));
}

function normalizeEnvVar(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCsv(raw: string | undefined): string | null {
  const trimmed = normalizeEnvVar(raw);
  if (trimmed === null) return null;
  const parts = trimmed
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts.join(",") : null;
}

function toHttpBaseUrl(serverUrl: string): string {
  return serverUrl
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/+$/, "");
}

function buildAgentName(ctx: MoltzapSpawnContext): string {
  const raw = `zb-${ctx.projectName as unknown as string}-${ctx.issue}-${shortSuffix()}`.toLowerCase();
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

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
