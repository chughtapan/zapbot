import { describe, it, expect } from "vitest";
import { mapWebhookToEvent, stripQuotedContent, parseMentionCommand } from "../src/webhook/mapper.js";

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

  it("returns null for issue_comment.created without mention", () => {
    const result = mapWebhookToEvent("issue_comment", {
      action: "created",
      comment: { body: "just a regular comment", id: 1 },
      issue: { number: 42 },
      sender: { login: "alice" },
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

// ── Label state override ───────────────────────────────────────────

describe("label_state_override", () => {
  it("emits override for 'planning' label", () => {
    const result = mapWebhookToEvent("issues", issuePayload("planning", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_state_override");
    if (result!.event.type === "label_state_override") {
      expect(result!.event.targetState).toBe("PLANNING");
      expect(result!.event.label).toBe("planning");
    }
  });

  it("emits override for 'implementing' label", () => {
    const result = mapWebhookToEvent("issues", issuePayload("implementing", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_state_override");
    if (result!.event.type === "label_state_override") {
      expect(result!.event.targetState).toBe("IMPLEMENTING");
    }
  });

  it("emits override for 'review' label", () => {
    const result = mapWebhookToEvent("issues", issuePayload("review", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_state_override");
    if (result!.event.type === "label_state_override") {
      expect(result!.event.targetState).toBe("REVIEW");
    }
  });

  it("emits override for 'verifying' label", () => {
    const result = mapWebhookToEvent("issues", issuePayload("verifying", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_state_override");
    if (result!.event.type === "label_state_override") {
      expect(result!.event.targetState).toBe("VERIFYING");
    }
  });

  it("emits override for 'triaged' label", () => {
    const result = mapWebhookToEvent("issues", issuePayload("triaged", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_state_override");
    if (result!.event.type === "label_state_override") {
      expect(result!.event.targetState).toBe("TRIAGED");
    }
  });

  it("does NOT emit override for bot's own labels", () => {
    const result = mapWebhookToEvent("issues", issuePayload("planning", "zapbot[bot]"));
    expect(result).toBeNull();
  });

  it("still handles plan-approved as label_added (not override)", () => {
    const result = mapWebhookToEvent("issues", issuePayload("plan-approved", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_added");
  });

  it("still handles triage as triage_label_added (not override)", () => {
    const result = mapWebhookToEvent("issues", issuePayload("triage", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("triage_label_added");
  });

  it("still handles abandoned as label_abandoned (not override)", () => {
    const result = mapWebhookToEvent("issues", issuePayload("abandoned", "human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("label_abandoned");
  });

  it("ignores unknown labels", () => {
    const result = mapWebhookToEvent("issues", issuePayload("wontfix", "human"));
    expect(result).toBeNull();
  });
});

// ── stripQuotedContent ────────────────────────────────────────────

describe("stripQuotedContent", () => {
  it("removes fenced code blocks", () => {
    const body = "before\n```\n@zapbot plan this\n```\nafter";
    expect(stripQuotedContent(body)).toBe("before\n\nafter");
  });

  it("removes inline code", () => {
    const body = "try running `@zapbot status` to check";
    expect(stripQuotedContent(body)).toBe("try running  to check");
  });

  it("removes blockquote lines", () => {
    const body = "my comment\n> @zapbot plan this\nnext line";
    expect(stripQuotedContent(body)).toBe("my comment\nnext line");
  });

  it("removes indented blockquote lines", () => {
    const body = "line 1\n  > quoted mention\nline 3";
    expect(stripQuotedContent(body)).toBe("line 1\nline 3");
  });

  it("handles multi-line code blocks with language tag", () => {
    const body = "look:\n```bash\n@zapbot investigate\necho done\n```\nend";
    expect(stripQuotedContent(body)).toBe("look:\n\nend");
  });

  it("passes through plain text unchanged", () => {
    const body = "just a normal comment with no special formatting";
    expect(stripQuotedContent(body)).toBe(body);
  });
});

// ── parseMentionCommand ───────────────────────────────────────────

describe("parseMentionCommand", () => {
  it("parses simple command after @zapbot", () => {
    expect(parseMentionCommand("@zapbot plan this", "zapbot[bot]")).toBe("plan this");
  });

  it("parses command after @zapbot[bot]", () => {
    expect(parseMentionCommand("@zapbot[bot] status", "zapbot[bot]")).toBe("status");
  });

  it("is case-insensitive for the mention", () => {
    expect(parseMentionCommand("@Zapbot plan this", "zapbot[bot]")).toBe("plan this");
  });

  it("returns null when no mention present", () => {
    expect(parseMentionCommand("just a regular comment", "zapbot[bot]")).toBeNull();
  });

  it("returns null when mention is bare with no command", () => {
    expect(parseMentionCommand("@zapbot", "zapbot[bot]")).toBeNull();
  });

  it("returns null when mention is only in a code block", () => {
    expect(parseMentionCommand("```\n@zapbot plan this\n```", "zapbot[bot]")).toBeNull();
  });

  it("returns null when mention is only in inline code", () => {
    expect(parseMentionCommand("try `@zapbot status`", "zapbot[bot]")).toBeNull();
  });

  it("returns null when mention is only in a blockquote", () => {
    expect(parseMentionCommand("> @zapbot plan this", "zapbot[bot]")).toBeNull();
  });

  it("extracts only the first line after mention", () => {
    expect(parseMentionCommand("@zapbot investigate this\nmore context here", "zapbot[bot]")).toBe("investigate this");
  });

  it("handles mention mid-line", () => {
    expect(parseMentionCommand("hey @zapbot help", "zapbot[bot]")).toBe("help");
  });

  it("works with custom bot username", () => {
    expect(parseMentionCommand("@mybot do something", "mybot")).toBe("do something");
  });
});

// ── mention_command mapping via mapWebhookToEvent ─────────────────

describe("issue_comment mention_command", () => {
  function commentPayload(body: string, actor = "alice", issueNumber = 42, commentId = 100) {
    return {
      action: "created",
      comment: { body, id: commentId },
      issue: { number: issueNumber },
      sender: { login: actor },
      repository: { full_name: "acme/app" },
    };
  }

  it("maps @zapbot mention to mention_command event", () => {
    const result = mapWebhookToEvent("issue_comment", commentPayload("@zapbot plan this"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("mention_command");
    if (result!.event.type === "mention_command") {
      expect(result!.event.command).toBe("plan this");
      expect(result!.event.triggeredBy).toBe("alice");
      expect(result!.event.commentId).toBe(100);
      expect(result!.event.issueNumber).toBe(42);
    }
    expect(result!.issueNumber).toBe(42);
    expect(result!.repo).toBe("acme/app");
  });

  it("maps @zapbot[bot] mention to mention_command event", () => {
    const result = mapWebhookToEvent("issue_comment", commentPayload("@zapbot[bot] status"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("mention_command");
    if (result!.event.type === "mention_command") {
      expect(result!.event.command).toBe("status");
    }
  });

  it("returns null when bot comments on its own (self-loop prevention)", () => {
    const result = mapWebhookToEvent(
      "issue_comment",
      commentPayload("@zapbot plan this", "zapbot[bot]"),
      "zapbot[bot]"
    );
    expect(result).toBeNull();
  });

  it("returns null for comment without mention", () => {
    const result = mapWebhookToEvent("issue_comment", commentPayload("looks good to me"));
    expect(result).toBeNull();
  });

  it("returns null for mention inside a code block", () => {
    const result = mapWebhookToEvent("issue_comment", commentPayload("```\n@zapbot plan this\n```"));
    expect(result).toBeNull();
  });

  it("returns null for bare mention without command text", () => {
    const result = mapWebhookToEvent("issue_comment", commentPayload("@zapbot"));
    expect(result).toBeNull();
  });

  it("includes the full comment body in the event", () => {
    const body = "@zapbot investigate this\n\nHere is more context about the bug.";
    const result = mapWebhookToEvent("issue_comment", commentPayload(body));
    expect(result).not.toBeNull();
    if (result!.event.type === "mention_command") {
      expect(result!.event.body).toBe(body);
      expect(result!.event.command).toBe("investigate this");
    }
  });

  it("uses custom bot username for matching", () => {
    const result = mapWebhookToEvent(
      "issue_comment",
      commentPayload("@mybot help"),
      "mybot"
    );
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("mention_command");
  });
});

// ── External close ─────────────────────────────────────────────────

describe("issue_closed_externally", () => {
  function closedPayload(actor: string, issueNumber = 42) {
    return {
      action: "closed",
      sender: { login: actor },
      issue: { number: issueNumber },
      repository: { full_name: "acme/app" },
    };
  }

  it("emits issue_closed_externally when human closes issue", () => {
    const result = mapWebhookToEvent("issues", closedPayload("human"));
    expect(result).not.toBeNull();
    expect(result!.event.type).toBe("issue_closed_externally");
    expect(result!.event.triggeredBy).toBe("human");
    expect(result!.issueNumber).toBe(42);
  });

  it("ignores close events from the bot itself", () => {
    const result = mapWebhookToEvent("issues", closedPayload("zapbot[bot]"));
    expect(result).toBeNull();
  });

  it("includes correct repo", () => {
    const result = mapWebhookToEvent("issues", closedPayload("human"));
    expect(result!.repo).toBe("acme/app");
  });
});
