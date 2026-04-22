import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { Effect } from "effect";
import type { GitHubAuthConfig } from "../config/schema.ts";
import type { Logger } from "../logger.ts";
import { ok } from "../types.ts";

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

export type GitHubClientInitError = {
  readonly _tag: "GitHubAuthInvalid";
  readonly cause: string;
};

export interface InstallationTokenPair {
  readonly token: string;
  readonly expiresAt: string;
}

function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  return { owner, repo: name };
}

export function createGitHubClient(
  auth: GitHubAuthConfig,
  logger: Logger,
): Effect.Effect<GitHubClient, GitHubClientInitError, never> {
  return Effect.try({
    try: () => wrapOctokit(buildOctokit(auth), logger),
    catch: (cause) => ({
      _tag: "GitHubAuthInvalid",
      cause: cause instanceof Error ? cause.message : String(cause),
    } satisfies GitHubClientInitError),
  });
}

export function getInstallationToken(
  auth: GitHubAuthConfig,
) : Effect.Effect<InstallationTokenPair | null, GitHubClientInitError, never> {
  return Effect.tryPromise({
    try: async () => {
      if (auth._tag === "GitHubPat") {
        return null;
      }
      const appAuth = createAppAuth({
        appId: auth.appId,
        privateKey: auth.privateKeyPem,
        installationId: auth.installationId,
      });
      const minted = await appAuth({ type: "installation" });
      return {
        token: minted.token,
        expiresAt: minted.expiresAt,
      };
    },
    catch: (cause) => ({
        _tag: "GitHubAuthInvalid",
        cause: cause instanceof Error ? cause.message : String(cause),
      } satisfies GitHubClientInitError),
  });
}

function buildOctokit(auth: GitHubAuthConfig): Octokit {
  switch (auth._tag) {
    case "GitHubPat":
      if (auth.token.trim().length === 0) {
        throw new Error("ZAPBOT_GITHUB_TOKEN must be non-empty.");
      }
      return new Octokit({ auth: auth.token });
    case "GitHubApp":
      if (auth.appId.trim().length === 0) {
        throw new Error("GITHUB_APP_ID must be non-empty.");
      }
      if (auth.installationId.trim().length === 0) {
        throw new Error("GITHUB_APP_INSTALLATION_ID must be non-empty.");
      }
      if (auth.privateKeyPem.trim().length === 0) {
        throw new Error("GITHUB_APP_PRIVATE_KEY must be non-empty.");
      }
      return new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: auth.appId,
          privateKey: auth.privateKeyPem,
          installationId: auth.installationId,
        },
      });
    default:
      return absurd(auth);
  }
}

function wrapOctokit(octokit: Octokit, log: Logger): GitHubClient {
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
      } catch (error) {
        const err = error as { readonly status?: number };
        if (err.status === 404) return;
        throw error;
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
      log.debug("Creating issue", { repo, title });
      const { data } = await octokit.rest.issues.create({ ...r, title, body, labels });
      return data.html_url;
    },

    async editIssue(repo, issueNumber, updates) {
      const r = splitRepo(repo);
      log.debug(`Editing issue #${issueNumber}`, { repo, issueNumber });
      await octokit.rest.issues.update({ ...r, issue_number: issueNumber, ...updates } as never);
    },

    async convertPrToDraft(repo, prNumber) {
      const r = splitRepo(repo);
      log.debug(`Converting PR #${prNumber} to draft via GraphQL`, { repo, prNumber });
      const { data: pr } = await octokit.rest.pulls.get({ ...r, pull_number: prNumber });
      await octokit.graphql(
        `mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`,
        { id: pr.node_id },
      );
    },

    async addReaction(repo, commentId, reaction) {
      const r = splitRepo(repo);
      log.debug(`Adding '${reaction}' reaction to comment ${commentId}`, { repo, commentId });
      await octokit.rest.reactions.createForIssueComment({ ...r, comment_id: commentId, content: reaction as never });
    },

    async addIssueReaction(repo, issueNumber, reaction) {
      const r = splitRepo(repo);
      log.debug(`Adding '${reaction}' reaction to issue #${issueNumber}`, { repo, issueNumber });
      await octokit.rest.reactions.createForIssue({ ...r, issue_number: issueNumber, content: reaction as never });
    },

    async assignIssue(repo, issueNumber, assignees) {
      const r = splitRepo(repo);
      log.debug(`Assigning ${assignees.join(", ")} to #${issueNumber}`, { repo, issueNumber });
      await octokit.rest.issues.addAssignees({ ...r, issue_number: issueNumber, assignees });
    },

    async getIssue(repo, issueNumber) {
      const r = splitRepo(repo);
      const { data } = await octokit.rest.issues.get({ ...r, issue_number: issueNumber });
      return {
        state: data.state === "closed" ? "closed" as const : "open" as const,
        body: data.body || "",
      };
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
      return data.map((hook) => ({ id: hook.id, config: { url: hook.config.url } }));
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
      const payload: Record<string, unknown> = { ...r, hook_id: hookId };
      if (config.url || config.content_type || config.secret) {
        payload.config = {
          ...(config.url ? { url: config.url } : {}),
          ...(config.content_type ? { content_type: config.content_type } : {}),
          ...(config.secret ? { secret: config.secret } : {}),
        };
      }
      if (config.active !== undefined) payload.active = config.active;
      await octokit.rest.repos.updateWebhook(payload as never);
    },

    async deactivateWebhook(repo, hookId) {
      const r = splitRepo(repo);
      await octokit.rest.repos.updateWebhook({ ...r, hook_id: hookId, active: false });
    },
  };
}

function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
