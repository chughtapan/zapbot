import { readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../logger.js";

const log = createLogger("config");

// ── Types ──────────────────────────────────────────────────────────

export interface WebhookConfig {
  path: string;
  secretEnvVar: string;
  signatureHeader: string;
  eventHeader: string;
}

export interface ScmConfig {
  plugin: string;
  webhook: WebhookConfig;
}

export interface ProjectConfig {
  repo: string;
  path: string;
  defaultBranch: string;
  sessionPrefix: string;
  agentRulesFile: string;
  scm: ScmConfig;
}

export interface ZapbotConfig {
  port: number;
  projects: Record<string, ProjectConfig>;
}

/** Lookup entry returned by the repo map. */
export interface RepoEntry {
  projectName: string;
  config: ProjectConfig;
}

/** Immutable lookup from repo full_name → project info. */
export type RepoMap = ReadonlyMap<string, RepoEntry>;

// ── Loading ────────────────────────────────────────────────────────

/**
 * Load and parse agent-orchestrator.yaml, returning the repo→project map.
 *
 * Falls back to a single-repo map built from ZAPBOT_REPO env var when
 * no config file is provided (backward compat).
 */
export function loadConfig(configPath?: string): {
  config: ZapbotConfig | null;
  repoMap: RepoMap;
} {
  if (configPath) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parseYaml(raw) as ZapbotConfig;
      const repoMap = buildRepoMap(parsed);
      log.info(`Loaded config from ${configPath}`, { repos: repoMap.size });
      return { config: parsed, repoMap };
    } catch (err) {
      log.error(`Failed to load config from ${configPath}: ${err}`);
      throw new Error(`Cannot load config: ${configPath}: ${err}`);
    }
  }

  // Backward compat: single-repo from env var
  const singleRepo = process.env.ZAPBOT_REPO;
  if (singleRepo) {
    log.info("No config file; using ZAPBOT_REPO env var for single-repo mode", { repo: singleRepo });
    const repoMap = new Map<string, RepoEntry>([
      [singleRepo, {
        projectName: singleRepo.split("/").pop() || singleRepo,
        config: {
          repo: singleRepo,
          path: process.cwd(),
          defaultBranch: "main",
          sessionPrefix: (singleRepo.split("/").pop() || "zap").slice(0, 3),
          agentRulesFile: ".agent-rules.md",
          scm: {
            plugin: "github",
            webhook: {
              path: "/api/webhooks/github",
              secretEnvVar: "GITHUB_WEBHOOK_SECRET",
              signatureHeader: "x-hub-signature-256",
              eventHeader: "x-github-event",
            },
          },
        },
      }],
    ]);
    return { config: null, repoMap };
  }

  // No config, no env var — empty map (open mode, any repo accepted)
  log.warn("No config file and no ZAPBOT_REPO — bridge will accept webhooks from any repo");
  return { config: null, repoMap: new Map() };
}

// ── Helpers ─────────────────────────────────────────────────────────

function buildRepoMap(config: ZapbotConfig): RepoMap {
  const map = new Map<string, RepoEntry>();
  if (!config.projects) return map;

  for (const [projectName, project] of Object.entries(config.projects)) {
    if (!project.repo) continue;
    map.set(project.repo, { projectName, config: project });
  }
  return map;
}

/**
 * Resolve the webhook secret for a given repo.
 *
 * Priority:
 * 1. Per-repo secret from the config's secretEnvVar (if different from shared)
 * 2. Shared GITHUB_WEBHOOK_SECRET
 */
export function resolveWebhookSecret(
  repoFullName: string,
  repoMap: RepoMap,
  sharedSecret: string
): string {
  const entry = repoMap.get(repoFullName);
  if (!entry) return sharedSecret;

  const envVar = entry.config.scm?.webhook?.secretEnvVar;
  if (envVar && envVar !== "GITHUB_WEBHOOK_SECRET") {
    const perRepoSecret = process.env[envVar];
    if (perRepoSecret) return perRepoSecret;
  }

  return sharedSecret;
}
