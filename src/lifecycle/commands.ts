import type {
  LifecycleCommandError,
  LifecycleCommandSpec,
  LifecycleDocsTouchpoint,
} from "./contracts.ts";
import type { Result } from "../types.ts";

export interface LifecycleCommandInput {
  readonly argv: ReadonlyArray<string>;
}

export interface LifecycleCommand {
  readonly name: LifecycleCommandSpec["name"];
  readonly args: ReadonlyArray<string>;
}

export function parseLifecycleCommand(
  input: LifecycleCommandInput,
): Result<LifecycleCommand, LifecycleCommandError> {
  throw new Error("not implemented");
}

export function renderLifecycleHelp(
  commands: ReadonlyArray<LifecycleCommandSpec>,
): string {
  throw new Error("not implemented");
}

export function listLifecycleCommands(): ReadonlyArray<LifecycleCommandSpec> {
  throw new Error("not implemented");
}

export function lifecycleDocsTouchpoints(): ReadonlyArray<LifecycleDocsTouchpoint> {
  throw new Error("not implemented");
}
