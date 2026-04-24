/**
 * src/config/canonical — decode `~/.zapbot/config.json` at the filesystem
 * boundary.
 *
 * Owns one boundary only: reading the canonical shared-secrets file and
 * decoding it through `CanonicalConfigSchema` into `CanonicalConfig`. The
 * bridge (and any other caller) receives typed secrets or a tagged
 * `ConfigDiskError`; no callers touch raw JSON.
 *
 * Per PRINCIPLES.md §2 the schema is the single decode site. Callers trust
 * `CanonicalConfig` fields are non-empty strings.
 */

import { Schema } from "effect";
import { err, ok, type Result } from "../types.ts";
import type { ConfigDiskError } from "./types.ts";
import { formatSchemaCause, type ConfigDiskReader } from "./disk.ts";

export const CanonicalConfigSchema = Schema.Struct({
  webhookSecret: Schema.NonEmptyString,
  apiKey: Schema.NonEmptyString,
});

export type CanonicalConfig = Schema.Schema.Type<typeof CanonicalConfigSchema>;

export function readCanonicalConfig(
  path: string,
  reader: ConfigDiskReader,
): Result<CanonicalConfig, ConfigDiskError> {
  const raw = reader.readText(path);
  if (raw._tag === "Err") {
    if (isMissingFileError(raw.error)) {
      return err({ _tag: "CanonicalConfigMissing", path });
    }
    return raw;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.value);
  } catch (cause) {
    return err({ _tag: "CanonicalConfigInvalid", path, cause: String(cause) });
  }

  try {
    return ok(Schema.decodeUnknownSync(CanonicalConfigSchema)(parsed));
  } catch (cause) {
    return err({
      _tag: "CanonicalConfigInvalid",
      path,
      cause: formatSchemaCause(cause),
    });
  }
}

function isMissingFileError(error: ConfigDiskError): boolean {
  return error._tag === "ConfigFileUnreadable" && /\bENOENT\b/.test(error.cause);
}
