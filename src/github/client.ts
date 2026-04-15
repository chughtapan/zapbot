import { createLogger } from "../logger.js";

const log = createLogger("github");
const API_BASE = "https://api.github.com";

export interface GitHubClient {
  addLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  removeLabel(repo: string, issueNumber: number, label: string): Promise<void>;
  postComment(repo: string, issueNumber: number, body: string): Promise<void>;
  closeIssue(repo: string, issueNumber: number): Promise<void>;
  createIssue(repo: string, title: string, body: string, labels: string[]): Promise<string>;
  editIssue(repo: string, issueNumber: number, updates: Record<string, unknown>): Promise<void>;
  convertPrToDraft(repo: string, prNumber: number): Promise<void>;
  getIssueState(repo: string, issueNumber: number): Promise<"open" | "closed">;
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

// ── Token-based client ──────────────────────────────────────────────

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

function createTokenClient(token: string): GitHubClient {
  return {
    async addLabel(repo, issueNumber, label) {
      log.debug(`Adding label '${label}' to #${issueNumber} via API`, { repo, issueNumber, label });
      await ghFetch(token, `/repos/${repo}/issues/${issueNumber}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      });
    },

    async removeLabel(repo, issueNumber, label) {
      log.debug(`Removing label '${label}' from #${issueNumber} via API`, { repo, issueNumber, label });
      try {
        await ghFetch(token, `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
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
      await ghFetch(token, `/repos/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    async closeIssue(repo, issueNumber) {
      log.debug(`Closing issue #${issueNumber} via API`, { repo, issueNumber });
      await ghFetch(token, `/repos/${repo}/issues/${issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify({ state: "closed" }),
      });
    },

    async getIssueState(repo, issueNumber) {
      const resp = await ghFetch(token, `/repos/${repo}/issues/${issueNumber}`);
      const data = await resp.json() as { state: string };
      return data.state === "closed" ? "closed" : "open";
    },

    async createIssue(repo, title, body, labels) {
      log.debug(`Creating issue via API`, { repo, title });
      const resp = await ghFetch(token, `/repos/${repo}/issues`, {
        method: "POST",
        body: JSON.stringify({ title, body, labels }),
      });
      const data = await resp.json() as { html_url: string };
      return data.html_url;
    },

    async editIssue(repo, issueNumber, updates) {
      log.debug(`Editing issue #${issueNumber} via API`, { repo, issueNumber });
      await ghFetch(token, `/repos/${repo}/issues/${issueNumber}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      });
    },

    async convertPrToDraft(repo, prNumber) {
      // GraphQL is required for converting to draft — REST can't do this
      log.debug(`Converting PR #${prNumber} to draft via GraphQL`, { repo, prNumber });
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
      const resp = await ghFetch(token, `/repos/${repo}/hooks`);
      return resp.json() as Promise<Array<{ id: number; config: { url?: string } }>>;
    },

    async createWebhook(repo, config) {
      const resp = await ghFetch(token, `/repos/${repo}/hooks`, {
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
      await ghFetch(token, `/repos/${repo}/hooks/${hookId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
    },

    async deactivateWebhook(repo, hookId) {
      await ghFetch(token, `/repos/${repo}/hooks/${hookId}`, {
        method: "PATCH",
        body: JSON.stringify({ active: false }),
      });
    },
  };
}

// ── Legacy gh CLI client ────────────────────────────────────────────

function createLegacyClient(): GitHubClient {
  async function runGh(args: string[]): Promise<string> {
    const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      const errMsg = `gh ${args.join(" ")} → ${stderr.trim()}`;
      log.error(`gh command failed: ${errMsg}`);
      throw new Error(errMsg);
    }
    return output.trim();
  }

  return {
    async addLabel(repo, issueNumber, label) {
      await runGh(["issue", "edit", String(issueNumber), "--repo", repo, "--add-label", label]);
    },
    async removeLabel(repo, issueNumber, label) {
      await runGh(["issue", "edit", String(issueNumber), "--repo", repo, "--remove-label", label]);
    },
    async postComment(repo, issueNumber, body) {
      await runGh(["issue", "comment", String(issueNumber), "--repo", repo, "--body", body]);
    },
    async closeIssue(repo, issueNumber) {
      await runGh(["issue", "close", String(issueNumber), "--repo", repo]);
    },
    async getIssueState(repo, issueNumber) {
      const result = await runGh(["issue", "view", String(issueNumber), "--repo", repo, "--json", "state", "--jq", ".state"]);
      return result.trim().toLowerCase() === "closed" ? "closed" : "open";
    },
    async createIssue(repo, title, body, labels) {
      const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
      for (const l of labels) args.push("--label", l);
      return runGh(args);
    },
    async editIssue(repo, issueNumber, updates) {
      const args = ["issue", "edit", String(issueNumber), "--repo", repo];
      if (updates.body) args.push("--body", String(updates.body));
      if (updates.title) args.push("--title", String(updates.title));
      await runGh(args);
    },
    async convertPrToDraft(repo, prNumber) {
      await runGh(["pr", "ready", String(prNumber), "--repo", repo, "--undo"]);
    },
    async listWebhooks(repo) {
      const output = await runGh(["api", `repos/${repo}/hooks`]);
      return JSON.parse(output || "[]");
    },
    async createWebhook(repo, config) {
      const output = await runGh([
        "api", `repos/${repo}/hooks`, "--method", "POST",
        "-f", `config[url]=${config.url}`,
        "-f", `config[content_type]=${config.content_type}`,
        "-f", `config[secret]=${config.secret}`,
        ...config.events.flatMap((e) => ["-F", `events[]=${e}`]),
        "-F", `active=${config.active}`,
        "--jq", ".id",
      ]);
      return parseInt(output, 10);
    },
    async updateWebhook(repo, hookId, config) {
      const args = ["api", `repos/${repo}/hooks/${hookId}`, "--method", "PATCH"];
      if (config.url) args.push("-f", `config[url]=${config.url}`);
      if (config.content_type) args.push("-f", `config[content_type]=${config.content_type}`);
      if (config.secret) args.push("-f", `config[secret]=${config.secret}`);
      if (config.active !== undefined) args.push("-F", `active=${config.active}`);
      await runGh(args);
    },
    async deactivateWebhook(repo, hookId) {
      await runGh(["api", `repos/${repo}/hooks/${hookId}`, "--method", "PATCH", "-F", "active=false"]);
    },
  };
}

// ── Factory ─────────────────────────────────────────────────────────

export function createGitHubClient(): GitHubClient {
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
