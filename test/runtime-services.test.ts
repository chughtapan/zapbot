import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { asBotUsername } from "../src/types.ts";

const sharedClient = {
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
  postComment: vi.fn(),
  updateComment: vi.fn(),
  closeIssue: vi.fn(),
  createIssue: vi.fn(),
  editIssue: vi.fn(),
  convertPrToDraft: vi.fn(),
  addReaction: vi.fn(),
  addIssueReaction: vi.fn(),
  assignIssue: vi.fn(),
  getIssue: vi.fn(),
  getIssueState: vi.fn(),
  getIssueBody: vi.fn(),
  listIssuesWithLabel: vi.fn(),
  listIssueEvents: vi.fn(),
  getUserPermission: vi.fn(),
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deactivateWebhook: vi.fn(),
};

const stateService = {
  getIssue: vi.fn(),
  getAgentClaim: vi.fn(),
  listOpenIssuesWithLabel: vi.fn(),
  postComment: vi.fn(),
  getLinkedPullRequest: vi.fn(),
};

const createGitHubClientMock = vi.fn(() => Effect.succeed(sharedClient));
const getInstallationTokenMock = vi.fn(() => Effect.succeed(null));
const createGitHubStateServiceMock = vi.fn(() => stateService);
const createLoggerFactoryMock = vi.fn(() => Effect.succeed({
  create: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("../src/github/client.ts", () => ({
  createGitHubClient: createGitHubClientMock,
  getInstallationToken: getInstallationTokenMock,
}));

vi.mock("../src/github-state.ts", () => ({
  createGitHubStateService: createGitHubStateServiceMock,
}));

vi.mock("../src/logger.ts", () => ({
  createLoggerFactory: createLoggerFactoryMock,
}));

describe("createRuntimeServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds github-state from the shared GitHub client boundary", async () => {
    const { createRuntimeServices } = await import("../src/runtime/services.ts");

    const services = await Effect.runPromise(createRuntimeServices({
      projectHome: {
        projectKey: "demo" as never,
        homePath: "/tmp/.zapbot/projects/demo" as never,
        checkoutPath: "/tmp/repo" as never,
      },
      bridgePort: 3000,
      aoPort: 3001,
      botUsername: asBotUsername("zapbot[bot]"),
      ingress: {
        _tag: "LocalOnly",
        mode: "local-only",
        gatewayUrl: null,
        publicUrl: null,
        requiresReachablePublicUrl: false,
      },
      gatewaySecret: null,
      githubAuth: {
        _tag: "GitHubPat",
        token: "gh-token",
      },
      moltzap: {
        _tag: "MoltzapDisabled",
      },
      logLevel: "info",
      apiKey: "api-key",
      routes: new Map(),
    }));

    expect(createGitHubClientMock).toHaveBeenCalledTimes(1);
    expect(createGitHubStateServiceMock).toHaveBeenCalledTimes(1);
    expect(createGitHubStateServiceMock).toHaveBeenCalledWith(sharedClient, expect.anything());
    expect(services.githubClient).toBe(sharedClient);
    expect(services.githubState).toBe(stateService);
  });
});
