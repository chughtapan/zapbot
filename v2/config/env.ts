import { type Result } from "../types.ts";
import type {
  ConfigEnvError,
  NormalizedRuntimeEnv,
  ParsedEnvFile,
} from "./types.ts";

export function parseEnvFile(
  content: string,
): Result<ParsedEnvFile, ConfigEnvError> {
  throw new Error("not implemented");
}

export function resolveRuntimeEnv(
  processEnv: Record<string, string | undefined>,
  parsedEnvFile: ParsedEnvFile | null,
): Result<NormalizedRuntimeEnv, ConfigEnvError> {
  throw new Error("not implemented");
}
