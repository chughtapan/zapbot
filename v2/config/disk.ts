import { type Result } from "../types.ts";
import type {
  ConfigDiskError,
  ConfigSourcePaths,
  ProjectConfigDocument,
  RawConfigFiles,
} from "./types.ts";

export interface ConfigDiskReader {
  readonly readText: (path: string) => Result<string, ConfigDiskError>;
}

export function readConfigFiles(
  paths: ConfigSourcePaths,
  reader: ConfigDiskReader,
): Result<RawConfigFiles, ConfigDiskError> {
  throw new Error("not implemented");
}

export function parseProjectConfig(
  path: string,
  rawYaml: string,
): Result<ProjectConfigDocument, ConfigDiskError> {
  throw new Error("not implemented");
}
