import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
});

describe("ao-plugin-agent-claude-moltzap", () => {
  it("does not synthesize MOLTZAP_* from operator-facing ZAPBOT_* vars", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "zapbot-worker-plugin-"));
    tempDirs.push(tempDir);
    const builtinPath = writeBuiltinPlugin(tempDir);

    process.env = { ...originalEnv };
    process.env.AO_BUILTIN_CLAUDE_PLUGIN_PATH = builtinPath;
    process.env.ZAPBOT_MOLTZAP_SERVER_URL = "wss://moltzap.example/ws";
    process.env.ZAPBOT_MOLTZAP_REGISTRATION_SECRET = "reg-secret";
    delete process.env.MOLTZAP_SERVER_URL;
    delete process.env.MOLTZAP_REGISTRATION_SECRET;
    delete process.env.MOLTZAP_ALLOWED_SENDERS;
    delete process.env.MOLTZAP_API_KEY;

    const plugin = await import(/* @vite-ignore */ pluginModuleUrl("legacy"));
    const env = plugin.create().getEnvironment({});

    expect(env.BUILTIN_ENV).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBeUndefined();
    expect(env.MOLTZAP_SERVER_URL).toBeUndefined();
    expect(env.MOLTZAP_REGISTRATION_SECRET).toBeUndefined();
  });

  it("passes through direct session-local MOLTZAP_* vars", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "zapbot-worker-plugin-"));
    tempDirs.push(tempDir);
    const builtinPath = writeBuiltinPlugin(tempDir);

    process.env = { ...originalEnv };
    process.env.AO_BUILTIN_CLAUDE_PLUGIN_PATH = builtinPath;
    process.env.MOLTZAP_SERVER_URL = "wss://moltzap.example/ws";
    process.env.MOLTZAP_REGISTRATION_SECRET = "reg-secret";
    process.env.MOLTZAP_ALLOWED_SENDERS = "orch-1";

    const plugin = await import(/* @vite-ignore */ pluginModuleUrl("direct"));
    const env = plugin.create().getEnvironment({});

    expect(env.MOLTZAP_SERVER_URL).toBe("wss://moltzap.example/ws");
    expect(env.MOLTZAP_REGISTRATION_SECRET).toBe("reg-secret");
    expect(env.MOLTZAP_ALLOWED_SENDERS).toBe("orch-1");
  });
});

function writeBuiltinPlugin(tempDir: string): string {
  const builtinPath = join(tempDir, "builtin-claude-plugin.mjs");
  writeFileSync(
    builtinPath,
    [
      "export const manifest = { name: 'builtin-claude' };",
      "export function create() {",
      "  return {",
      "    name: 'builtin-claude',",
      "    processName: 'bash',",
      "    getLaunchCommand() { return 'claude'; },",
      "    getEnvironment() {",
      "      return { BUILTIN_ENV: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };",
      "    },",
      "  };",
      "}",
      "export function detect() { return true; }",
      "",
    ].join("\n"),
    "utf8",
  );
  return builtinPath;
}

function pluginModuleUrl(suffix: string): string {
  return `${pathToFileURL(
    join(process.cwd(), "worker", "ao-plugin-agent-claude-moltzap", "index.js"),
  ).href}?test=${suffix}-${Date.now()}`;
}
