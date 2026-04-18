import { readFileSync } from "fs";
import { loadConfig, type RepoMap } from "./loader.js";
import { createLogger } from "../logger.js";

const log = createLogger("config-reload");

export interface ReloadableConfig {
  webhookSecret: string;
  repoMap: RepoMap;
}

/**
 * Parse a .env file into key-value pairs.
 * Skips comments and blank lines. Does not modify process.env.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    if (line.startsWith("#") || !line.includes("=")) continue;
    const [key, ...rest] = line.split("=");
    vars[key.trim()] = rest.join("=").trim();
  }
  return vars;
}

/**
 * Reload config from disk. Returns the new config if valid, or null if
 * validation fails (caller should keep old config).
 *
 * Validation rules:
 * - ZAPBOT_WEBHOOK_SECRET must be non-empty after re-read
 * - YAML config must parse without error (if configPath provided)
 */
export function reloadConfigFromDisk(
  envFilePath: string | undefined,
  configPath: string | undefined,
  currentSecret: string
): { config: ReloadableConfig; secretRotated: boolean } | null {
  try {
    // Re-read .env if path is known
    let envVars: Record<string, string> = {};
    if (envFilePath) {
      const envContent = readFileSync(envFilePath, "utf-8");
      envVars = parseEnvFile(envContent);
      // Apply to process.env so loadConfig can pick up new values
      for (const [key, value] of Object.entries(envVars)) {
        process.env[key] = value;
      }
    }

    const newConfig = loadConfig(configPath);
    const newSecret = process.env.ZAPBOT_WEBHOOK_SECRET;

    // Validate before applying
    if (!newSecret) {
      log.error("Config reload failed: ZAPBOT_WEBHOOK_SECRET is empty after re-read. Keeping old config.");
      return null;
    }

    const secretRotated = newSecret !== currentSecret;

    log.info(`Config reloaded (${newConfig.repoMap.size} repos, secret rotated: ${secretRotated})`);

    return {
      config: {
        webhookSecret: newSecret,
        repoMap: newConfig.repoMap,
      },
      secretRotated,
    };
  } catch (err) {
    log.error(`Config reload failed: ${err}. Keeping old config.`);
    return null;
  }
}
