/**
 * moltzap/session-client — decode `MOLTZAP_*` env into a typed struct
 * the bin entry can hand to `@moltzap/claude-code-channel`.
 *
 * After the sbd#172 transplant, the "connector" abstraction (opaque SDK
 * handle + connect/disconnect) is obsolete — `@moltzap/client`'s
 * `MoltZapService` replaces it wholesale. Only the role-aware env decode
 * stays on zapbot (research verdict §(b) STAYS row 2).
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";
import type { MoltzapSenderId } from "./types.ts";
import { asMoltzapSenderId } from "./types.ts";

/**
 * Binary boot-endpoint role (orchestrator vs. worker). Distinct from
 * `SessionRole` in `./session-role.ts`, which governs peer-channel
 * addressing. See original zap#133 doctrine for the intentional coexistence.
 */
export type SessionRole = "orchestrator" | "worker";

export interface SessionClientEnv {
  readonly role: SessionRole;
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly localSenderId: MoltzapSenderId;
  readonly orchestratorSenderId: MoltzapSenderId | null;
  readonly allowlistCsv: string | null;
}

export type SessionClientConfigError =
  | { readonly _tag: "MissingServerUrl" }
  | { readonly _tag: "MissingApiKey" }
  | { readonly _tag: "MissingLocalSenderId" }
  | { readonly _tag: "MissingOrchestratorSenderId"; readonly role: "worker" }
  | { readonly _tag: "InvalidServerUrl"; readonly value: string };

/**
 * Decode the role-specific `MOLTZAP_*` environment for the current AO session.
 * `serverUrl` is the base client URL, not the `/ws` transport suffix.
 */
export function loadSessionClientEnv(
  env: Record<string, string | undefined>,
  role: SessionRole,
): Result<SessionClientEnv, SessionClientConfigError> {
  const serverUrl = normalizeEnvVar(env.MOLTZAP_SERVER_URL);
  if (serverUrl === null) {
    return err({ _tag: "MissingServerUrl" });
  }
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  if (normalizedServerUrl === null) {
    return err({ _tag: "InvalidServerUrl", value: serverUrl });
  }
  const apiKey = normalizeEnvVar(env.MOLTZAP_API_KEY);
  if (apiKey === null) {
    return err({ _tag: "MissingApiKey" });
  }
  const localSenderId = normalizeEnvVar(env.MOLTZAP_LOCAL_SENDER_ID);
  if (localSenderId === null) {
    return err({ _tag: "MissingLocalSenderId" });
  }
  const orchestratorSenderId = normalizeEnvVar(env.MOLTZAP_ORCHESTRATOR_SENDER_ID);
  if (role === "worker" && orchestratorSenderId === null) {
    return err({ _tag: "MissingOrchestratorSenderId", role: "worker" });
  }
  return ok({
    role,
    serverUrl: normalizedServerUrl,
    apiKey,
    localSenderId: asMoltzapSenderId(localSenderId),
    orchestratorSenderId:
      orchestratorSenderId === null ? null : asMoltzapSenderId(orchestratorSenderId),
    allowlistCsv: normalizeCsv(env.MOLTZAP_ALLOWED_SENDERS),
  });
}

function normalizeEnvVar(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCsv(raw: string | undefined): string | null {
  const value = normalizeEnvVar(raw);
  if (value === null) return null;
  const normalized = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(",");
  return normalized.length > 0 ? normalized : null;
}

function normalizeServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return null;
    }
    if (url.pathname === "/ws" || url.pathname === "/ws/") {
      url.pathname = "/";
    } else if (url.pathname.endsWith("/ws")) {
      url.pathname = url.pathname.slice(0, -3) || "/";
    }
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
