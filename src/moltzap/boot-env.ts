/**
 * moltzap/boot-env — parse the AO session's `MOLTZAP_*` env into a boot
 * struct, applying the registration-secret HTTP fallback when
 * `MOLTZAP_API_KEY` is absent.
 *
 * Extracted from the former `bin/moltzap-claude-channel.ts` so the bin
 * stays under spec A8's LOC budget.
 */

import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";

export interface ChannelBootstrap {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly localSenderId: string;
}

export async function resolveChannelBootstrap(
  env: NodeJS.ProcessEnv,
): Promise<Result<ChannelBootstrap, string>> {
  const serverUrl = normalizeServerUrl(env.MOLTZAP_SERVER_URL);
  if (serverUrl === null) return err("MOLTZAP_SERVER_URL is required");
  const apiKey = trim(env.MOLTZAP_API_KEY);
  if (apiKey !== null) {
    // Static-mode correctness: when MOLTZAP_API_KEY is provided (MoltzapStatic
    // path in runtime.ts), the orchestrator does NOT derive a sender_id, so
    // the operator must set MOLTZAP_LOCAL_SENDER_ID explicitly. Pre-sbd#172
    // this path fell back to the MoltZapService `hello.agentId`, but that
    // fallback was subsumed by upstream @moltzap/claude-code-channel and is
    // no longer reachable from here. Failing loud beats silently writing an
    // empty `moltzap_sender_id` into AO session metadata — downstream peer
    // allowlist matching would drop orchestrator↔worker traffic otherwise.
    // sbd#190 will delete MoltzapStatic entirely; until then, require the id.
    const localSenderId = trim(env.MOLTZAP_LOCAL_SENDER_ID);
    if (localSenderId === null) {
      return err(
        "MOLTZAP_LOCAL_SENDER_ID is required when MOLTZAP_API_KEY is set " +
          "(static MoltZap mode). Registration-backed deployments (using " +
          "MOLTZAP_REGISTRATION_SECRET) derive it automatically.",
      );
    }
    return ok({ serverUrl, apiKey, localSenderId });
  }
  const registrationSecret = trim(env.MOLTZAP_REGISTRATION_SECRET);
  if (registrationSecret === null) {
    return err("either MOLTZAP_API_KEY or MOLTZAP_REGISTRATION_SECRET is required");
  }
  const name =
    trim(env.AO_SESSION_NAME) ?? trim(env.AO_SESSION) ?? `zb-${Date.now().toString(36)}`;
  const httpBase = serverUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  let res: Response;
  try {
    res = await fetch(`${httpBase}/api/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, inviteCode: registrationSecret }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    return err(`registration failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return err(`registration failed (${res.status}): ${body || "empty"}`);
  }
  const payload = (await res.json().catch(() => ({}))) as {
    apiKey?: unknown;
    agentId?: unknown;
  };
  if (typeof payload.apiKey !== "string" || typeof payload.agentId !== "string") {
    return err("registration response missing apiKey/agentId");
  }
  return ok({ serverUrl, apiKey: payload.apiKey, localSenderId: payload.agentId });
}

function trim(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function normalizeServerUrl(raw: string | undefined): string | null {
  const t = trim(raw);
  if (t === null) return null;
  try {
    const url = new URL(t);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return null;
    if (url.pathname === "/ws" || url.pathname === "/ws/") url.pathname = "/";
    else if (url.pathname.endsWith("/ws")) url.pathname = url.pathname.slice(0, -3) || "/";
    const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
