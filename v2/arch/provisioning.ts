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

export type MoltzapRuntimeConfig =
  | { readonly _tag: "MoltzapDisabled" }
  | {
      readonly _tag: "MoltzapStatic";
      readonly serverUrl: string;
      readonly apiKey: string;
      readonly allowlistCsv: string | null;
    }
  | {
      readonly _tag: "MoltzapRegistration";
      readonly serverUrl: string;
      readonly registrationSecret: string;
      readonly allowlistCsv: string | null;
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
  env: Readonly<Record<string, string | undefined>>,
): Result<MoltzapRuntimeConfig, MoltzapConfigError> {
  throw new Error("not implemented");
}

export function buildMoltzapSpawnEnv(
  config: MoltzapRuntimeConfig,
  ctx: MoltzapSpawnContext,
): Promise<Result<Readonly<Record<string, string>>, MoltzapProvisionError>> {
  throw new Error("not implemented");
}
