import { describe, expect, it } from "vitest";
import {
  autoConfirmClaudeChannelPrompt,
  buildClaudeChannelLaunchCommand,
  normalizeClaudeChannelTerminalText,
  shouldConfirmClaudeChannelPrompt,
} from "../src/claude-channel-launch.ts";

describe("buildClaudeChannelLaunchCommand", () => {
  it("appends the Claude channel flags to the base command", () => {
    expect(buildClaudeChannelLaunchCommand("claude --resume 'abc'")).toBe(
      "claude --resume 'abc' --mcp-config '.claude/moltzap-channel.mcp.json' --dangerously-load-development-channels server:moltzap",
    );
  });
});

describe("shouldConfirmClaudeChannelPrompt", () => {
  it("detects the explicit development-channel warning text", () => {
    expect(
      shouldConfirmClaudeChannelPrompt(
        "\u001b[1mI am using this for local development and confirm loading development channels\u001b[0m",
      ),
    ).toBe(true);
  });

  it("falls back to keyword detection when the exact banner changes", () => {
    expect(
      shouldConfirmClaudeChannelPrompt(
        "Before loading these development channels, please confirm this local development action.",
      ),
    ).toBe(true);
  });

  it("does not match unrelated terminal output", () => {
    expect(shouldConfirmClaudeChannelPrompt("Claude is starting normally.")).toBe(false);
  });

  it("normalizes ANSI output before matching", () => {
    expect(
      normalizeClaudeChannelTerminalText("\u001b[31mLoading   development\tchannels\u001b[0m"),
    ).toBe("loading development channels");
  });
});

describe("autoConfirmClaudeChannelPrompt", () => {
  it("sends Enter when the prompt appears in the tmux pane", async () => {
    const tmuxCalls: string[][] = [];
    let captures = 0;
    let now = 0;

    const outcome = await autoConfirmClaudeChannelPrompt({
      tmuxTarget: "demo-1",
      maxWaitMs: 2_000,
      pollIntervalMs: 100,
      pokeScheduleMs: [],
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      runTmux: async (args) => {
        tmuxCalls.push([...args]);
        if (args[0] === "capture-pane") {
          captures += 1;
          return captures === 1
            ? "loading development channels\nplease confirm"
            : "";
        }
        return "";
      },
    });

    expect(outcome).toBe("confirmed");
    expect(tmuxCalls).toContainEqual(["send-keys", "-t", "demo-1", "Enter"]);
  });

  it("returns not-needed when the session already advanced past registration", async () => {
    const outcome = await autoConfirmClaudeChannelPrompt({
      tmuxTarget: "demo-2",
      maxWaitMs: 1_000,
      pollIntervalMs: 100,
      pokeScheduleMs: [],
      runTmux: async (args) => {
        if (args[0] === "capture-pane") {
          return "Channel notifications registered";
        }
        throw new Error(`unexpected tmux call: ${args.join(" ")}`);
      },
      sleep: async () => {},
    });

    expect(outcome).toBe("not-needed");
  });

  it("times out cleanly when no prompt appears", async () => {
    let now = 0;
    const outcome = await autoConfirmClaudeChannelPrompt({
      tmuxTarget: "demo-3",
      maxWaitMs: 300,
      pollIntervalMs: 100,
      pokeScheduleMs: [],
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      runTmux: async () => "",
    });

    expect(outcome).toBe("timeout");
  });
});
