import { createSign } from "crypto";
import { readFileSync } from "fs";
import { createLogger } from "../logger.js";

const log = createLogger("github");
const API_BASE = "https://api.github.com";

export interface GitHubClient {
  addLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  postComment(repo: string, issueNumber: number, body: string): Promise<{ id: number }>;
  updateComment(repo: string, commentId: number, body: string): Promise<void>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  createIssue(repo: string, title: string, body: string, labels: string[]): Promise<string>;
  editIssue(repo: string, issueNumber: number, updates: Record<string, unknown>): Promise<void>;
  convertPrToDraft(repo: string, prNumber: number): Promise<void>;
  getIssue(repo: string, issueNumber: number): Promise<{ state: "open" | "closed"; body: string }>;
  getIssueState(repo: string, issueNumber: number): Promise<"open" | "closed">;
  getIssueBody(repo: string, issueNumber: number): Promise<string>;
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

/** A function that returns a valid GitHub API token. */
type TokenProvider = () => Promise<string>;

// ── Low-level fetch ────────────────────────────────────────────────

async function ghFetch(
  token: string,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...((options.headers as Record<string, string>) || {}),
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const msg = `GitHub API ${options.method || "GET"} ${path} → ${resp.status}: ${body}`;
    log.error(msg);
    throw new Error(msg);
  }

  return resp;
}

// ── REST client (shared by token + app modes) ──────────────────────

function createRestClient(getToken: TokenProvider): GitHubClient {
  /** Resolve token then delegate to ghFetch. */
  async function authedFetch(path: string, options: RequestInit = {}): Promise<Response> {
    return ghFetch(await getToken(), path, options);
  }

  return {
    async addLabel(repo, issueNumber, label) {
      log.debug(`Adding label '${label}' to #${issueNumber} via API`, { repo, issueNumber, label });
      await authedFetch(`/repos/${repo}/issues/${issueNumber}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      });
    },

    async removeLabel(repo, issueNumber, label) {
      log.debug(`Removing label '${label}' from #${issueNumber} via API`, { repo, issueNumber, label });
      try {
        await authedFetch(`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
          method: "DELETE",
        });
      } catch (err: any) {
        // 404 means label wasn't there, which is fine
        if (err.message?.includes("404")) return;
        throw err;
      }
    },

    async postComment(repo, issueNumber, body) {
      log.debug(`Posting comment on #${issueNumber} via API`, { repo, issueNumber });
      const resp = await authedFetch(`/repos/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      const data = await resp.json() as { id: number };
      return { id: data.id };
    },

    async updateComment(repo, commentId, body) {
      log.debug(`Updating comment ${commentId} via API`, { repo, commentId });
      await authedFetch(`/repos/${repo}/issues/comments/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
    },

    async closeIssue(repo, issueNumber) {
      log.debug(`Closing issue #${issueNumber} via API`, { repo, issueNumber });
      await authedFetch(`/repos/${repo}/issues/${issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
    },

    async getIssue(repo, issueNumber) {
      const resp = await authedFetch(`/repos/${repo}/issues/${issueNumber}`);
      const data = await resp.json() as { state: string; body: string | null };
      return { state: data.state === "closed" ? "closed" as const : "open" as const, body: data.body || "" };
    },

    async getIssueState(repo, issueNumber) {
      return (await this.getIssue(repo, issueNumber)).state;
    },

    async getIssueBody(repo, issueNumber) {
      return (await this.getIssue(repo, issueNumber)).body;
    },

    async createIssue(repo, title, body, labels) {
      log.debug(`Creating issue via API`, { repo, title });
      const resp = await authedFetch(`/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title, body, labels }),
      });
      const data = await resp.json() as { html_url: string };
      return data.html_url;
    },

    async editIssue(repo, issueNumber, updates) {
      log.debug(`Editing issue #${issueNumber} via API`, { repo, issueNumber });
      await authedFetch(`/repos/${repo}/issues/${issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
    },

    async convertPrToDraft(repo, prNumber) {
      // GraphQL is required for converting to draft — REST can't do this
      log.debug(`Converting PR #${prNumber} to draft via GraphQL`, { repo, prNumber });
      const token = await getToken();

      // First get the node ID of the PR
      const resp = await ghFetch(token, `/repos/${repo}/pulls/${prNumber}`);
      const pr = await resp.json() as { node_id: string };

      const gqlResp = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: `mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`,
          variables: { id: pr.node_id },
        }),
      });
      if (!gqlResp.ok) {
        const body = await gqlResp.text().catch(() => "");
        throw new Error(`GraphQL convertPullRequestToDraft failed: ${gqlResp.status}: ${body.slice(0, 200)}`);
      }
    },

    async listWebhooks(repo) {
      const resp = await authedFetch(`/repos/${repo}/hooks`);
      return resp.json() as Promise<Array<{ id: number; config: { url?: string } }>>;
    },

    async createWebhook(repo, config) {
      const resp = await authedFetch(`/repos/${repo}/hooks`, {
        method: "POST",
        body: JSON.stringify({
          config: {
            url: config.url,
            content_type: config.content_type,
            secret: config.secret,
          },
          events: config.events,
          active: config.active,
        }),
      });
      const data = await resp.json() as { id: number };
      return data.id;
    },

    async updateWebhook(repo, hookId, config) {
      const payload: Record<string, unknown> = {};
      if (config.url || config.content_type || config.secret) {
        payload.config = {
          ...(config.url && { url: config.url }),
          ...(config.content_type && { content_type: config.content_type }),
          ...(config.secret && { secret: config.secret }),
        };
      }
      if (config.active !== undefined) payload.active = config.active;
      await authedFetch(`/repos/${repo}/hooks/${hookId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },

    async deactivateWebhook(repo, hookId) {
      await authedFetch(`/repos/${repo}/hooks/${hookId}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
      });
    },
  };
}

// ── Token-based client ─────────────────────────────────────────────

function createTokenClient(token: string): GitHubClient {
  return createRestClient(() => Promise.resolve(token));
}

// ── GitHub App auth ────────────────────────────────────────────────

/**
 * Load a PEM private key from env var. The value can be either:
 * - The PEM content directly (starts with "-----BEGIN")
 * - A file path to a .pem file
 */
export function loadPrivateKey(): string {
  const keyOrPath = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!keyOrPath) throw new Error("GITHUB_APP_PRIVATE_KEY is required for GitHub App auth");

  if (keyOrPath.startsWith("-----BEGIN")) return keyOrPath;

  // Treat as file path
  try {
    return readFileSync(keyOrPath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read private key file: ${keyOrPath}: ${err}`);
  }
}

/**
 * Generate a short-lived JWT for GitHub App authentication.
 * Used to exchange for installation access tokens.
 */
export function generateAppJWT(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: appId,
    iat: now - 60,   // 60s in the past for clock drift
    exp: now + 600,  // 10 minutes max
  })).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  const signature = sign.sign(privateKeyPem, "base64url");

  return `${signingInput}.${signature}`;
}

/**
 * Create a client that authenticates as a GitHub App installation.
 * Caches installation tokens and refreshes them at 50 minutes (tokens last 1hr).
 */
function createAppClient(appId: string, privateKey: string, installationId: string): GitHubClient {
  let cached: { token: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.token;
    }

    log.debug("Refreshing GitHub App installation token", { appId, installationId });
    const jwt = generateAppJWT(appId, privateKey);

    const resp = await fetch(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Failed to get installation token: ${resp.status}: ${body}`);
    }

    const data = await resp.json() as { token: string; expires_at: string };

    // Refresh at 50 minutes (tokens last 1hr)
    cached = {
      token: data.token,
      expiresAt: now + 50 * 60 * 1000,
    };

    log.info("GitHub App installation token refreshed");
    return data.token;
  }

  return createRestClient(getToken);
}

// ── Legacy client: resolves token from `gh auth token`, then uses REST ─────

function createLegacyClient(): GitHubClient {
  async function resolveGhToken(): Promise<string> {
    const proc = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error("gh auth token failed — is `gh` authenticated?");
    }
    return output.trim();
  }

  return createRestClient(resolveGhToken);
}

// ── Factory ─────────────────────────────────────────────────────────

export function createGitHubClient(): GitHubClient {
  // Priority 1: GitHub App auth
  const appId = process.env.GITHUB_APP_ID;
  if (appId) {
    const privateKey = loadPrivateKey();
    const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
    if (!installationId) {
      throw new Error("GITHUB_APP_INSTALLATION_ID is required when using GitHub App auth");
    }
    log.info("Using GitHub App for API calls", { appId, installationId });
    return createAppClient(appId, privateKey, installationId);
  }

  // Priority 2: PAT / legacy
  const mode = process.env.ZAPBOT_AUTH_MODE || "bot";
  const token = process.env.ZAPBOT_GITHUB_TOKEN;

  if (mode === "legacy" || !token) {
    if (mode !== "legacy" && !token) {
      log.warn("ZAPBOT_GITHUB_TOKEN not set, falling back to gh CLI (legacy mode)");
    }
    log.info("Using legacy gh CLI for GitHub API calls");
    return createLegacyClient();
  }

  log.info("Using bot token for GitHub API calls");
  return createTokenClient(token);
}
