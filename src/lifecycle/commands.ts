import type {
  LifecycleCommandError,
  LifecycleCommandName,
  LifecycleCommandSpec,
  LifecycleDocsTouchpoint,
} from "./contracts.ts";
import { err, ok, type Result } from "../types.ts";

export interface LifecycleCommandInput {
  readonly argv: ReadonlyArray<string>;
}

export interface LifecycleCommand {
  readonly name: LifecycleCommandSpec["name"];
  readonly args: ReadonlyArray<string>;
}

const LIFECYCLE_COMMANDS: ReadonlyArray<LifecycleCommandSpec> = [
  {
    name: "status",
    summary: "Show managed-session state for the current project.",
    managedOnly: true,
    docAnchor: "README.md",
  },
  {
    name: "stop",
    summary: "Stop one zapbot-managed session by explicit session id.",
    managedOnly: true,
    docAnchor: "ARCHITECTURE.md",
  },
  {
    name: "gc",
    summary: "Garbage-collect stale zapbot-managed sessions only.",
    managedOnly: true,
    docAnchor: "ARCHITECTURE.md",
  },
  {
    name: "reconcile",
    summary: "Reconcile managed records against live AO runtime state.",
    managedOnly: true,
    docAnchor: "README.md",
  },
  {
    name: "help",
    summary: "Print lifecycle command help.",
    managedOnly: false,
    docAnchor: "README.md",
  },
] as const;

const LIFECYCLE_DOCS_TOUCHPOINTS: ReadonlyArray<LifecycleDocsTouchpoint> = [
  {
    file: "README.md",
    section: "Managed session lifecycle",
    command: "status",
    note: "Explain that stop and GC target only zapbot-managed sessions recorded in the lifecycle registry.",
  },
  {
    file: "ARCHITECTURE.md",
    section: "Startup and shutdown",
    command: "reconcile",
    note: "Document that startup reconciliation and GC operate only on explicit managed ownership records.",
  },
] as const;

export function parseLifecycleCommand(
  input: LifecycleCommandInput,
): Result<LifecycleCommand, LifecycleCommandError> {
  const [rawName, ...rawArgs] = input.argv;
  const commandName = normalizeCommandName(rawName);
  if (commandName === null) {
    return err({
      _tag: "LifecycleCommandUnknown",
      input: rawName ?? "",
    });
  }

  if (commandName === "stop" && rawArgs.length === 0) {
    return err({
      _tag: "LifecycleCommandMissingSession",
      command: "stop",
    });
  }

  if (commandName === "stop" && rawArgs[0].trim().length === 0) {
    return err({
      _tag: "LifecycleCommandInvalidTarget",
      input: rawArgs[0],
      reason: "stop requires a non-empty managed session id",
    });
  }

  return ok({
    name: commandName,
    args: rawArgs,
  });
}

export function renderLifecycleHelp(
  commands: ReadonlyArray<LifecycleCommandSpec>,
): string {
  return commands
    .map((command) =>
      `${command.name.padEnd(10, " ")} ${command.summary}${command.managedOnly ? " Managed sessions only." : ""}`,
    )
    .join("\n");
}

export function listLifecycleCommands(): ReadonlyArray<LifecycleCommandSpec> {
  return LIFECYCLE_COMMANDS;
}

export function lifecycleDocsTouchpoints(): ReadonlyArray<LifecycleDocsTouchpoint> {
  return LIFECYCLE_DOCS_TOUCHPOINTS;
}

function normalizeCommandName(input: string | undefined): LifecycleCommandName | null {
  if (typeof input !== "string") {
    return "help";
  }
  switch (input.trim().toLowerCase()) {
    case "":
    case "help":
    case "--help":
    case "-h":
      return "help";
    case "status":
    case "stop":
    case "gc":
    case "reconcile":
      return input.trim().toLowerCase() as LifecycleCommandName;
    default:
      return null;
  }
}
