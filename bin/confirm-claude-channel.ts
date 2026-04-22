#!/usr/bin/env bun

import process from "node:process";
import { autoConfirmClaudeChannelPrompt } from "../src/claude-channel-launch.ts";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const tmuxTarget = parseTmuxTarget(argv);
  const outcome = await autoConfirmClaudeChannelPrompt({ tmuxTarget });
  process.stdout.write(`${outcome}\n`);
}

function parseTmuxTarget(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--tmux-target") {
      const value = argv[index + 1];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
  }
  throw new Error("usage: bun run bin/confirm-claude-channel.ts --tmux-target <session>");
}

if (import.meta.main) {
  await main().catch((cause) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[confirm-claude-channel] ${message}`);
    process.exit(1);
  });
}
