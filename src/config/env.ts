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
  ParsedEnvFile,
} from "./types.ts";

function normalizeEnvValue(
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function parseEnvFile(
  content: string,
): Result<ParsedEnvFile, ConfigEnvError> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separatorIndex = rawLine.indexOf("=");
    if (separatorIndex === -1) {
      return err({ _tag: "MalformedEnvLine", line: rawLine });
    }
    const key = rawLine.slice(0, separatorIndex).trim();
    if (key.length === 0) {
      return err({ _tag: "MalformedEnvLine", line: rawLine });
    }
    values[key] = rawLine.slice(separatorIndex + 1).trim();
  }
  return ok({ values });
}

export function resolveRuntimeEnv(
  processEnv: Record<string, string | undefined>,
  parsedEnvFile: ParsedEnvFile | null,
): Result<NormalizedRuntimeEnv, ConfigEnvError> {
  const mergedEnv: Record<string, string | undefined> =
    parsedEnvFile === null
      ? { ...processEnv }
      : { ...processEnv, ...parsedEnvFile.values };

  const rawPort = normalizeEnvValue(mergedEnv.ZAPBOT_PORT) ?? "3000";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0) {
    return err({ _tag: "InvalidPort", raw: rawPort });
  }

  const apiKey = normalizeEnvValue(mergedEnv.ZAPBOT_API_KEY);
  if (apiKey === null) {
    return err({ _tag: "MissingRequiredEnv", key: "ZAPBOT_API_KEY" });
  }

  const webhookSecret = normalizeEnvValue(mergedEnv.ZAPBOT_WEBHOOK_SECRET);
  if (webhookSecret === null) {
    return err({ _tag: "MissingRequiredEnv", key: "ZAPBOT_WEBHOOK_SECRET" });
  }

  if (apiKey === webhookSecret) {
    return err({
      _tag: "SecretCollision",
      left: "ZAPBOT_API_KEY",
      right: "ZAPBOT_WEBHOOK_SECRET",
    });
  }

  const publicUrl = normalizeEnvValue(mergedEnv.ZAPBOT_BRIDGE_URL);
  const gatewayUrl = normalizeEnvValue(mergedEnv.ZAPBOT_GATEWAY_URL);
  const gatewaySecret = normalizeEnvValue(mergedEnv.ZAPBOT_GATEWAY_SECRET);
  const botUsername = asBotUsername(
    normalizeEnvValue(mergedEnv.ZAPBOT_BOT_USERNAME) ?? "zapbot[bot]",
  );

  const aoConfigPathValue =
    normalizeEnvValue(mergedEnv.AO_CONFIG_PATH) ??
    normalizeEnvValue(mergedEnv.ZAPBOT_CONFIG);
  const singleRepoValue = normalizeEnvValue(mergedEnv.ZAPBOT_REPO);

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
