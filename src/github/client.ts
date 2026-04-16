import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import { createLogger } from "../logger.js";

const log = createLogger("github");

export interface GitHubClient {
  addLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  postComment(repo: string, issueNumber: number, body: string): Promise<{ id: number }>;
  updateComment(repo: string, commentId: number, body: string): Promise<void>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  createIssue(repo: string, title: string, body: string, labels: string[]): Promise<string>;
  editIssue(repo: string, issueNumber: number, updates: Record<string, unknown>): Promise<void>;
  convertPrToDraft(repo: string, prNumber: number): Promise<void>;
  addReaction(repo: string, commentId: number, reaction: string): Promise<void>;
  addIssueReaction(repo: string, issueNumber: number, reaction: string): Promise<void>;
  assignIssue(repo: string, issueNumber: number, assignees: string[]): Promise<void>;
  getIssue(repo: string, issueNumber: number): Promise<{ state: "open" | "closed"; body: string }>;
  getIssueState(repo: string, issueNumber: number): Promise<"open" | "closed">;
  getIssueBody(repo: string, issueNumber: number): Promise<string>;
  getUserPermission(repo: string, username: string): Promise<string>;
  listWebhooks(repo: string): Promise<Array<{ id: number; config: { url?: string } }>>;
  createWebhook(repo: string, config: WebhookConfig): Promise<number>;
  updateWebhook(repo: string, hookId: number, config: Partial<WebhookConfig>): Promise<void>;
  deactivateWebhook(repo: string, hookId: number): Promise<void>;
}

export interface WebhookConfig {
  url: string;
  content_type: string;
  secret: string;
  events: string[];
  active: boolean;
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  return { owner, repo: name };
}

/**
 * Load a PEM private key from env var. The value can be either:
 * - The PEM content directly (starts with "-----BEGIN")
 * - A file path to a .pem file
 */
export function loadPrivateKey(): string {
  const keyOrPath = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!keyOrPath) throw new Error("GITHUB_APP_PRIVATE_KEY is required for GitHub App auth");

  if (keyOrPath.startsWith("-----BEGIN")) return keyOrPath;

  try {
    return readFileSync(keyOrPath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read private key file: ${keyOrPath}: ${err}`);
  }
}

function wrapOctokit(octokit: Octokit): GitHubClient {
  return {
    async addLabel(repo, issueNumber, label) {
      const r = splitRepo(repo);
      log.debug(`Adding label '${label}' to #${issueNumber}`, { repo, issueNumber, label });
      await octokit.rest.issues.addLabels({ ...r, issue_number: issueNumber, labels: [label] });
    },

    async removeLabel(repo, issueNumber, label) {
      const r = splitRepo(repo);
      log.debug(`Removing label '${label}' from #${issueNumber}`, { repo, issueNumber, label });
      try {
        await octokit.rest.issues.removeLabel({ ...r, issue_number: issueNumber, name: label });
      } catch (err: any) {
        if (err.status === 404) return;
        throw err;
      }
    },

    async postComment(repo, issueNumber, body) {
      const r = splitRepo(repo);
      log.debug(`Posting comment on #${issueNumber}`, { repo, issueNumber });
      const { data } = await octokit.rest.issues.createComment({ ...r, issue_number: issueNumber, body });
      return { id: data.id };
    },

    async updateComment(repo, commentId, body) {
      const r = splitRepo(repo);
      log.debug(`Updating comment ${commentId}`, { repo, commentId });
      await octokit.rest.issues.updateComment({ ...r, comment_id: commentId, body });
    },

    async closeIssue(repo, issueNumber) {
      const r = splitRepo(repo);
      log.debug(`Closing issue #${issueNumber}`, { repo, issueNumber });
      await octokit.rest.issues.update({ ...r, issue_number: issueNumber, state: "closed" });
    },

    async createIssue(repo, title, body, labels) {
      const r = splitRepo(repo);
      log.debug(`Creating issue`, { repo, title });
      const { data } = await octokit.rest.issues.create({ ...r, title, body, labels });
      return data.html_url;
    },

    async editIssue(repo, issueNumber, updates) {
      const r = splitRepo(repo);
      log.debug(`Editing issue #${issueNumber}`, { repo, issueNumber });
      await octokit.rest.issues.update({ ...r, issue_number: issueNumber, ...updates } as any);
    },

    async convertPrToDraft(repo, prNumber) {
      const r = splitRepo(repo);
      log.debug(`Converting PR #${prNumber} to draft via GraphQL`, { repo, prNumber });
      const { data: pr } = await octokit.rest.pulls.get({ ...r, pull_number: prNumber });
      await octokit.graphql(`mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`, {
        id: pr.node_id,
      });
    },

    async addReaction(repo, commentId, reaction) {
      const r = splitRepo(repo);
      log.debug(`Adding '${reaction}' reaction to comment ${commentId}`, { repo, commentId });
      await octokit.rest.reactions.createForIssueComment({ ...r, comment_id: commentId, content: reaction as any });
    },

    async addIssueReaction(repo, issueNumber, reaction) {
      const r = splitRepo(repo);
      log.debug(`Adding '${reaction}' reaction to issue #${issueNumber}`, { repo, issueNumber });
      await octokit.rest.reactions.createForIssue({ ...r, issue_number: issueNumber, content: reaction as any });
    },

    async assignIssue(repo, issueNumber, assignees) {
      const r = splitRepo(repo);
      log.debug(`Assigning ${assignees.join(", ")} to #${issueNumber}`, { repo, issueNumber });
      await octokit.rest.issues.addAssignees({ ...r, issue_number: issueNumber, assignees });
    },

    async getIssue(repo, issueNumber) {
      const r = splitRepo(repo);
      const { data } = await octokit.rest.issues.get({ ...r, issue_number: issueNumber });
      return { state: data.state === "closed" ? "closed" as const : "open" as const, body: data.body || "" };
    },

    async getIssueState(repo, issueNumber) {
      return (await this.getIssue(repo, issueNumber)).state;
    },

    async getIssueBody(repo, issueNumber) {
      return (await this.getIssue(repo, issueNumber)).body;
    },

    async getUserPermission(repo, username) {
      const r = splitRepo(repo);
      log.debug(`Checking permission for ${username}`, { repo, username });
      const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({ ...r, username });
      return data.permission;
    },

    async listWebhooks(repo) {
      const r = splitRepo(repo);
      const { data } = await octokit.rest.repos.listWebhooks({ ...r });
      return data.map((h) => ({ id: h.id, config: { url: h.config.url } }));
    },

    async createWebhook(repo, config) {
      const r = splitRepo(repo);
      const { data } = await octokit.rest.repos.createWebhook({
        ...r,
        config: { url: config.url, content_type: config.content_type, secret: config.secret },
        events: config.events,
        active: config.active,
      });
      return data.id;
    },

    async updateWebhook(repo, hookId, config) {
      const r = splitRepo(repo);
      const payload: any = { ...r, hook_id: hookId };
      if (config.url || config.content_type || config.secret) {
        payload.config = {
          ...(config.url && { url: config.url }),
          ...(config.content_type && { content_type: config.content_type }),
          ...(config.secret && { secret: config.secret }),
        };
      }
      if (config.active !== undefined) payload.active = config.active;
      await octokit.rest.repos.updateWebhook(payload);
    },

    async deactivateWebhook(repo, hookId) {
      const r = splitRepo(repo);
      await octokit.rest.repos.updateWebhook({ ...r, hook_id: hookId, active: false });
    },
  };
}

// ── Installation token for agent sessions ──────────────────────────

let _authInstance: ReturnType<typeof createAppAuth> | null = null;

/**
 * Get a fresh GitHub App installation token. Agents use this as GH_TOKEN
 * so gh CLI and git operations run as the bot, not the user.
 * Returns null if not using GitHub App auth (PAT mode).
 */
export async function getInstallationToken(): Promise<string | null> {
  if (!_authInstance) {
    const appId = process.env.GITHUB_APP_ID;
    if (!appId) return null;
    const privateKey = loadPrivateKey();
    const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
    if (!installationId) return null;
    _authInstance = createAppAuth({ appId, privateKey, installationId });
  }
  const auth = await _authInstance({ type: "installation" });
  return auth.token;
}

// ── Factory ─────────────────────────────────────────────────────────

export function createGitHubClient(): GitHubClient {
  // Priority 1: GitHub App auth (recommended)
  const appId = process.env.GITHUB_APP_ID;
  if (appId) {
    const privateKey = loadPrivateKey();
    const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
    if (!installationId) {
      throw new Error("GITHUB_APP_INSTALLATION_ID is required when using GitHub App auth");
    }
    log.info("Using GitHub App for API calls", { appId, installationId });
    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId,
        privateKey,
        installationId,
      },
    });
    return wrapOctokit(octokit);
  }

  // Priority 2: Personal access token
  const token = process.env.ZAPBOT_GITHUB_TOKEN;
  if (token) {
    log.info("Using personal access token for GitHub API calls");
    return wrapOctokit(new Octokit({ auth: token }));
  }

  throw new Error(
    "No GitHub credentials configured. Set GITHUB_APP_ID (recommended) or ZAPBOT_GITHUB_TOKEN in your .env"
  );
}
