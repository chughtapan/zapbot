#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolveManagedStartupRetry } from "../src/orchestrator/runtime.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const [projectDir, projectConfigPath, aoLogPath] = process.argv.slice(2);

if (!projectDir || !projectConfigPath || !aoLogPath) {
  fail("usage: resolve-managed-startup-retry.ts <project-dir> <project-config-path> <ao-log-path>");
}

let aoLogText = "";
try {
  aoLogText = readFileSync(aoLogPath, "utf8");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

const decision = await resolveManagedStartupRetry({
  projectDir,
  projectConfigPath,
  aoLogText,
});

if (decision.action === "retry") {
  process.stdout.write(`${decision.duplicateSession ?? ""}\n`);
  process.exit(0);
}

fail(decision.reason);
