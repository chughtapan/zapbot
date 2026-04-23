/**
 * Tests for the mcpServers boundary decode in
 * worker/ao-plugin-agent-claude-moltzap/index.js.
 *
 * Anchors: SPEC r4.1 Invariant 4 (reserved-key collision fail-fast),
 *          Invariant 5 (boundary decode).
 *
 * We test `ensureChannelMcpConfig` end-to-end via the exported `create()`
 * entry's `setupWorkspaceHooks`. Temp workspace is real fs; the test does
 * not spawn a Claude process.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG_REL = ".claude/moltzap-channel.mcp.json";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "zap-mcp-test-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

async function runHook(): Promise<void> {
  // Dynamic import so module-top-level `import builtin…` runs in isolation.
  const mod = (await import("../worker/ao-plugin-agent-claude-moltzap/index.js")) as unknown as {
    create: () => { setupWorkspaceHooks: (workspacePath: string, config: unknown) => Promise<void> };
  };
  const plugin = mod.create();
  await plugin.setupWorkspaceHooks(workspace, {});
}

describe("ensureChannelMcpConfig", () => {
  it("writes a fresh config when none exists", async () => {
    await runHook();
    const raw = readFileSync(join(workspace, CONFIG_REL), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.moltzap._zapbotAuthored).toBe(true);
    expect(parsed.mcpServers.moltzap.command).toBe("bun");
  });

  it("preserves zapbot-authored entries on a second run (ours)", async () => {
    await runHook();
    await runHook(); // second run must not throw
    const raw = readFileSync(join(workspace, CONFIG_REL), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.moltzap._zapbotAuthored).toBe(true);
  });

  it("fails fast on a reserved-key collision with a foreign moltzap entry", async () => {
    const configPath = join(workspace, CONFIG_REL);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          moltzap: {
            // NO _zapbotAuthored marker — this is a foreign entry.
            command: "rogue-cli",
            args: ["--evil"],
          },
        },
      }),
      "utf8",
    );
    await expect(runHook()).rejects.toThrow(/ReservedMcpKeyCollision/);
  });

  it("merges with existing mcpServers entries that do NOT shadow moltzap", async () => {
    const configPath = join(workspace, CONFIG_REL);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          otherServer: { command: "other", args: [] },
        },
        someTopLevelKey: true,
      }),
      "utf8",
    );
    await runHook();
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.otherServer).toEqual({ command: "other", args: [] });
    expect(parsed.mcpServers.moltzap._zapbotAuthored).toBe(true);
    expect(parsed.someTopLevelKey).toBe(true);
  });

  it("rejects a file that is not valid JSON (shape invalid)", async () => {
    const configPath = join(workspace, CONFIG_REL);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(configPath, "not json {", "utf8");
    await expect(runHook()).rejects.toThrow(/McpConfigShapeInvalid/);
  });

  it("rejects a file whose top-level is not an object", async () => {
    const configPath = join(workspace, CONFIG_REL);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(configPath, JSON.stringify([1, 2, 3]), "utf8");
    await expect(runHook()).rejects.toThrow(/McpConfigShapeInvalid/);
  });

  it("rejects a file whose mcpServers is not an object", async () => {
    const configPath = join(workspace, CONFIG_REL);
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: [1, 2, 3] }),
      "utf8",
    );
    await expect(runHook()).rejects.toThrow(/McpConfigShapeInvalid/);
  });
});
