import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROMPT_MARKERS = [
  "i am using this for local development",
  "loading development channels",
  "--dangerously-load-development-channels is for local channel development",
] as const;

const PROMPT_KEYWORDS = ["loading", "development", "channels", "confirm"] as const;

const READY_MARKERS = [
  "Channel notifications registered",
  "Channel notifications skipped",
] as const;

const ANSI_ESCAPE_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu;

export type ClaudeChannelPromptOutcome = "confirmed" | "not-needed" | "timeout";

export interface ClaudeChannelPromptOptions {
  readonly tmuxTarget: string;
  readonly captureLines?: number;
  readonly maxWaitMs?: number;
  readonly pollIntervalMs?: number;
  readonly pokeScheduleMs?: readonly number[];
  readonly runTmux?: TmuxRunner;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export type TmuxRunner = (args: readonly string[]) => Promise<string>;

export function buildClaudeChannelLaunchCommand(
  command: string,
  mcpConfigPath = ".claude/moltzap-channel.mcp.json",
): string {
  return [
    command,
    "--mcp-config",
    shellSingleQuote(mcpConfigPath),
    "--dangerously-load-development-channels",
    "server:moltzap",
  ].join(" ");
}

export function normalizeClaudeChannelTerminalText(raw: string): string {
  const withoutAnsi = raw.replace(ANSI_ESCAPE_RE, " ");
  return withoutAnsi.replace(/\s+/gu, " ").trim().toLowerCase();
}

export function shouldConfirmClaudeChannelPrompt(raw: string): boolean {
  const normalized = normalizeClaudeChannelTerminalText(raw);
  if (PROMPT_MARKERS.some((marker) => normalized.includes(marker))) {
    return true;
  }

  const lowered = raw.toLowerCase();
  return PROMPT_KEYWORDS.every((keyword) => lowered.includes(keyword));
}

export async function autoConfirmClaudeChannelPrompt(
  options: ClaudeChannelPromptOptions,
): Promise<ClaudeChannelPromptOutcome> {
  const runTmux = options.runTmux ?? runTmuxCommand;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const captureLines = options.captureLines ?? 200;
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const pokeScheduleMs = options.pokeScheduleMs ?? [100, 350, 800];

  const startedAt = now();
  let pokeIndex = 0;

  while (now() - startedAt <= maxWaitMs) {
    const elapsedMs = now() - startedAt;
    while (pokeIndex < pokeScheduleMs.length && elapsedMs >= pokeScheduleMs[pokeIndex]!) {
      await sendEnter(runTmux, options.tmuxTarget);
      pokeIndex += 1;
    }

    const output = await runTmux([
      "capture-pane",
      "-t",
      options.tmuxTarget,
      "-p",
      "-S",
      `-${captureLines}`,
    ]);
    if (READY_MARKERS.some((marker) => output.includes(marker))) {
      return "not-needed";
    }
    if (shouldConfirmClaudeChannelPrompt(output)) {
      await sendEnter(runTmux, options.tmuxTarget);
      return "confirmed";
    }

    await sleep(pollIntervalMs);
  }

  return "timeout";
}

async function sendEnter(runTmux: TmuxRunner, tmuxTarget: string): Promise<void> {
  await runTmux(["send-keys", "-t", tmuxTarget, "Enter"]);
}

async function runTmuxCommand(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", [...args], { timeout: 5_000 });
  return stdout.trimEnd();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}
