import { Schema } from "effect";
import { parse as parseYaml } from "yaml";
import {
  asProjectName,
  asRepoFullName,
  err,
  ok,
  type Result,
} from "../types.ts";
import type {
  ConfigDiskError,
  ConfigSourcePaths,
  ProjectConfigDocument,
  ProjectRouteDocument,
  RawConfigFiles,
} from "./types.ts";

export interface ConfigDiskReader {
  readonly readText: (path: string) => Result<string, ConfigDiskError>;
}

const WebhookSchema = Schema.Struct({
  path: Schema.String,
  secretEnvVar: Schema.String,
  signatureHeader: Schema.String,
  eventHeader: Schema.String,
});

const ProjectSchema = Schema.Struct({
  repo: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.String,
  scm: Schema.Struct({
    plugin: Schema.String,
    webhook: WebhookSchema,
  }),
});

const ProjectConfigSchema = Schema.Struct({
  port: Schema.Union(Schema.Number, Schema.Undefined),
  projects: Schema.Record({
    key: Schema.String,
    value: ProjectSchema,
  }),
});

type DecodedProjectConfig = Schema.Schema.Type<typeof ProjectConfigSchema>;

function decodeProjectConfig(
  path: string,
  rawYaml: string,
): Result<DecodedProjectConfig, ConfigDiskError> {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (cause) {
    return err({
      _tag: "ConfigFileInvalid",
      path,
      cause: String(cause),
    });
  }

  try {
    return ok(Schema.decodeUnknownSync(ProjectConfigSchema)(parsed));
  } catch (cause) {
    return err({
      _tag: "ConfigFileInvalid",
      path,
      cause: formatSchemaCause(cause),
    });
  }
}

export function formatSchemaCause(cause: unknown): string {
  if (cause && typeof cause === "object" && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

export function readConfigFiles(
  paths: ConfigSourcePaths,
  reader: ConfigDiskReader,
): Result<RawConfigFiles, ConfigDiskError> {
  let projectConfigText: string | null = null;
  if (paths.projectConfigPath !== null) {
    const configResult = reader.readText(paths.projectConfigPath);
    if (configResult._tag === "Err") return configResult;
    projectConfigText = configResult.value;
  }

  return ok({ projectConfigText });
}

export function parseProjectConfig(
  path: string,
  rawYaml: string,
): Result<ProjectConfigDocument, ConfigDiskError> {
  const decoded = decodeProjectConfig(path, rawYaml);
  if (decoded._tag === "Err") return decoded;

  const projects = new Map<ReturnType<typeof asProjectName>, ProjectRouteDocument>();

  for (const [projectName, project] of Object.entries(decoded.value.projects)) {
    const secretEnvVar = project.scm.webhook.secretEnvVar;
    if (secretEnvVar === "ZAPBOT_API_KEY") {
      return err({
        _tag: "DeprecatedSecretBinding",
        projectName,
        secretEnvVar,
      });
    }

    projects.set(asProjectName(projectName), {
      repo: asRepoFullName(project.repo),
      path: project.path,
      defaultBranch: project.defaultBranch,
      webhookSecretEnvVar: secretEnvVar,
    });
  }

  return ok({ projects });
}
