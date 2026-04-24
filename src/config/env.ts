import {
  asBotUsername,
  asRepoFullName,
  err,
  ok,
  type Result,
} from "../types.ts";
import type {
  ConfigEnvError,
  NormalizedRuntimeEnv,
} from "./types.ts";
import type { CanonicalConfig } from "./canonical.ts";

function normalizeEnvValue(
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveRuntimeEnv(
  processEnv: Record<string, string | undefined>,
  canonical: CanonicalConfig,
): Result<NormalizedRuntimeEnv, ConfigEnvError> {
  const rawPort = normalizeEnvValue(processEnv.ZAPBOT_PORT) ?? "3000";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    return err({ _tag: "InvalidPort", raw: rawPort });
  }

  const apiKey = canonical.apiKey;
  const webhookSecret = canonical.webhookSecret;

  if (apiKey === webhookSecret) {
    return err({
      _tag: "SecretCollision",
      left: "apiKey",
      right: "webhookSecret",
    });
  }

  const publicUrl = normalizeEnvValue(processEnv.ZAPBOT_BRIDGE_URL);
  const gatewayUrl = normalizeEnvValue(processEnv.ZAPBOT_GATEWAY_URL);
  const gatewaySecret = normalizeEnvValue(processEnv.ZAPBOT_GATEWAY_SECRET);
  const botUsername = asBotUsername(
    normalizeEnvValue(processEnv.ZAPBOT_BOT_USERNAME) ?? "zapbot[bot]",
  );

  const aoConfigPathValue = normalizeEnvValue(processEnv.ZAPBOT_CONFIG);
  const singleRepoValue = normalizeEnvValue(processEnv.ZAPBOT_REPO);

  return ok({
    port,
    publicUrl,
    gatewayUrl,
    gatewaySecret,
    botUsername,
    aoConfigPath: aoConfigPathValue as NormalizedRuntimeEnv["aoConfigPath"],
    apiKey,
    webhookSecret,
    singleRepo:
      singleRepoValue === null ? null : asRepoFullName(singleRepoValue),
  });
}
