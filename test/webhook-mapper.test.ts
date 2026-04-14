import { describe, it, expect } from "vitest";
import { mapWebhookToEvent } from "../src/webhook/mapper.js";

// ── Helpers ────────────────────────────────────────────────────────

function issuePayload(label: string, actor: string, issueNumber = 42) {
  return {
    action: "labeled",
    label: { name: label },
    sender: { login: actor },
    issue: { number: issueNumber },
    repository: { full_name: "acme/app" },
  };
}

function prPayload(
  action: string,
  overrides: Record<string, any> = {}
) {
  return {
    action,
    pull_request: {
      number: 99,
      draft: false,
      body: "Closes #42",
      merged: false,
      ...overrides,
    },
    sender: { login: "alice" },
    repository: { full_name: "acme/app" },
  };
}

// ── issues.labeled ─────────────────────────────────────────────────

describe("issues.labeled", () => {
  it("maps 'abandoned' label to label_abandoned event", () => {
    const result = mapWebhookToEvent("issues", issuePayload("abandoned", "alice"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_abandoned");
    expect(result!.issueNumber).toBe(42);
    expect(result!.repo).toBe("acme/app");
  });

  it("maps 'plan-approved' label to label_added event", () => {
    const result = mapWebhookToEvent("issues", issuePayload("plan-approved", "bob"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_added");
    if (result!.event.type === "label_added") {
      expect(result!.event.label).toBe("plan-approved");
    }
  });

  it("maps 'triage' label to triage_label_added event", () => {
    const result = mapWebhookToEvent("issues", issuePayload("triage", "carol"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("triage_label_added");
  });

  it("returns null when the bot labels (self-loop prevention)", () => {
    const result = mapWebhookToEvent(
      "issues",
      issuePayload("abandoned", "zapbot[bot]"),
      "zapbot[bot]"
    );
    expect(result).toBeNull();
  });

  it("returns null for an unrecognised label", () => {
    const result = mapWebhookToEvent("issues", issuePayload("enhancement", "alice"));
    expect(result).toBeNull();
  });
});

// ── pull_request.opened ────────────────────────────────────────────

describe("pull_request.opened", () => {
  it("maps draft PR to draft_pr_opened event", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("opened", { draft: true })
    );
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("draft_pr_opened");
    expect(result!.issueNumber).toBe(42);
    if (result!.event.type === "draft_pr_opened") {
      expect(result!.event.prNumber).toBe(99);
    }
  });

  it("maps non-draft PR to non_draft_pr_opened event", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("opened", { draft: false })
    );
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("non_draft_pr_opened");
  });

  it("returns null when PR body has no linked issue", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("opened", { body: "Just some changes" })
    );
    expect(result).toBeNull();
  });
});

// ── pull_request.ready_for_review ──────────────────────────────────

describe("pull_request.ready_for_review", () => {
  it("maps to pr_ready_for_review event", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("ready_for_review")
    );
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("pr_ready_for_review");
    expect(result!.issueNumber).toBe(42);
  });

  it("returns null when PR body has no linked issue", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("ready_for_review", { body: "no link" })
    );
    expect(result).toBeNull();
  });
});

// ── pull_request.closed (merged) ───────────────────────────────────

describe("pull_request.closed (merged)", () => {
  it("maps merged PR to verified_and_shipped event", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("closed", { merged: true })
    );
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("verified_and_shipped");
    expect(result!.issueNumber).toBe(42);
  });

  it("returns null for closed-but-not-merged PR", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("closed", { merged: false })
    );
    expect(result).toBeNull();
  });
});

// ── pull_request_review.submitted ──────────────────────────────────

describe("pull_request_review.submitted", () => {
  it("maps changes_requested review to changes_requested event", () => {
    const payload = {
      action: "submitted",
      review: { state: "changes_requested" },
      pull_request: { number: 99, body: "Fixes #42" },
      sender: { login: "reviewer" },
      repository: { full_name: "acme/app" },
    };
    const result = mapWebhookToEvent("pull_request_review", payload);
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("changes_requested");
    expect(result!.issueNumber).toBe(42);
  });

  it("returns null for approved review", () => {
    const payload = {
      action: "submitted",
      review: { state: "approved" },
      pull_request: { number: 99, body: "Fixes #42" },
      sender: { login: "reviewer" },
      repository: { full_name: "acme/app" },
    };
    const result = mapWebhookToEvent("pull_request_review", payload);
    expect(result).toBeNull();
  });

  it("returns null when PR body has no linked issue", () => {
    const payload = {
      action: "submitted",
      review: { state: "changes_requested" },
      pull_request: { number: 99, body: "random text" },
      sender: { login: "reviewer" },
      repository: { full_name: "acme/app" },
    };
    const result = mapWebhookToEvent("pull_request_review", payload);
    expect(result).toBeNull();
  });
});

// ── Unknown / unhandled events ─────────────────────────────────────

describe("unknown events", () => {
  it("returns null for unknown event type", () => {
    const result = mapWebhookToEvent("deployment", { repository: { full_name: "acme/app" } });
    expect(result).toBeNull();
  });

  it("returns null for issue_comment.created", () => {
    const result = mapWebhookToEvent("issue_comment", {
      action: "created",
      repository: { full_name: "acme/app" },
    });
    expect(result).toBeNull();
  });

  it("returns null for issues.opened", () => {
    const result = mapWebhookToEvent("issues", {
      action: "opened",
      issue: { number: 1, labels: [] },
      sender: { login: "alice" },
      repository: { full_name: "acme/app" },
    });
    expect(result).toBeNull();
  });
});

// ── Issue link parsing variants ────────────────────────────────────

describe("issue link parsing", () => {
  it("parses 'Fixes #10'", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("opened", { body: "Fixes #10" })
    );
    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(10);
  });

  it("parses 'Resolves #5'", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("opened", { body: "Resolves #5" })
    );
    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(5);
  });

  it("parses 'Part of #100'", () => {
    const result = mapWebhookToEvent(
      "pull_request",
      prPayload("opened", { body: "Part of #100" })
    );
    expect(result).not.toBeNull();
    expect(result!.issueNumber).toBe(100);
  });
});
