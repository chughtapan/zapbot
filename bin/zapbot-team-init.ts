#!/usr/bin/env bun

import process from "node:process";
import { Effect } from "effect";
import { appendProjectRoute, initializeProjectConfig } from "../src/config/bootstrap.ts";

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  ensureGhAuth();
  ensureLabels(parsed.repo);

  if (parsed.addRepo) {
    const receipt = await Effect.runPromise(appendProjectRoute({
      checkoutPath: process.cwd(),
      repo: parsed.repo,
      projectKey: parsed.projectKey,
    }));
    process.stdout.write(`Added ${parsed.repo} under ${receipt.projectHomePath}\n`);
    return;
  }

  const receipt = await Effect.runPromise(initializeProjectConfig({
    checkoutPath: process.cwd(),
    repo: parsed.repo,
    projectKey: parsed.projectKey,
  }));
  process.stdout.write(`Initialized ${receipt.projectKey as string} under ${receipt.projectHomePath}\n`);
  process.stdout.write(`Config: ${receipt.configPath}\n`);
}

function parseArgs(argv: readonly string[]): { readonly repo: string; readonly addRepo: boolean; readonly projectKey?: string } {
  let addRepo = false;
  let repo = "";
  let projectKey: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--add-repo") {
      addRepo = true;
      continue;
    }
    if (arg === "--project-key") {
      projectKey = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage:\n  bun run bin/zapbot-team-init.ts <owner/repo>\n  bun run bin/zapbot-team-init.ts [--project-key KEY] --add-repo <owner/repo>\n",
      );
      process.exit(0);
    }
    repo = arg;
  }
  if (repo.length === 0) {
    throw new Error("missing <owner/repo>");
  }
  return { repo, addRepo, projectKey };
}

function ensureGhAuth(): void {
  const child = Bun.spawnSync(["gh", "auth", "status"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (child.exitCode !== 0) {
    throw new Error("Not authenticated with GitHub. Run: gh auth login");
  }
}

function ensureLabels(repo: string): void {
  Bun.spawnSync([
    "gh",
    "label",
    "create",
    "zapbot-plan",
    "--repo",
    repo,
    "--color",
    "0E8A16",
    "--description",
    "Plan published via zapbot",
    "--force",
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

await main().catch((error) => {
  console.error(formatCliError(error));
  process.exit(1);
});

function formatCliError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "_tag" in error) {
    const tagged = error as { readonly _tag: string; readonly checkoutPath?: string };
    if (tagged._tag === "BootstrapProjectKeyRequired") {
      return `BootstrapProjectKeyRequired: checkout ${tagged.checkoutPath ?? process.cwd()} is not yet bound to a canonical ~/.zapbot project; rerun with --project-key <existing-project-key>.`;
    }
    if (tagged._tag === "BootstrapHomeMissing") {
      return "BootstrapHomeMissing: HOME must be set for canonical ~/.zapbot config.";
    }
    return JSON.stringify(error);
  }
  return String(error);
}
