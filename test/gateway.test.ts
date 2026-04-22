import { describe, it, expect } from "vitest";
import { verifyAndClassify, type GatewayWebhookEnvelope } from "../src/gateway.ts";
import { asBotUsername, asDeliveryId, asProjectName, asRepoFullName } from "../src/types.ts";

const bot = asBotUsername("zapbot[bot]");

async function signPayload(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function buildEnvelope(
  body: string,
  secret: string,
  overrides?: Partial<GatewayWebhookEnvelope>
): Promise<GatewayWebhookEnvelope> {
  return {
    rawBody: body,
    signature: await signPayload(body, secret),
    eventType: "issue_comment",
    deliveryId: asDeliveryId("d-1"),
    repo: asRepoFullName("acme/app"),
    payload: JSON.parse(body),
    ...overrides,
  };
}

describe("verifyAndClassify", () => {
  const secret = "s3cr3t";
  const resolveProjectName = () => asProjectName("app");

  it("returns SecretMissing when resolveSecret returns null", async () => {
    const env = await buildEnvelope(JSON.stringify({ action: "created" }), secret);
    const r = await verifyAndClassify(env, () => null, resolveProjectName, bot);
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") expect(r.error._tag).toBe("SecretMissing");
  });

  it("returns SignatureMismatch on bad signature", async () => {
    const body = JSON.stringify({ action: "created" });
    const env: GatewayWebhookEnvelope = {
      rawBody: body,
      signature: "sha256=deadbeef",
      eventType: "issue_comment",
      deliveryId: asDeliveryId("d-1"),
      repo: asRepoFullName("acme/app"),
      payload: JSON.parse(body),
    };
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") expect(r.error._tag).toBe("SignatureMismatch");
  });

  it("ignores non-issue_comment events", async () => {
    const body = JSON.stringify({ action: "opened" });
    const env = await buildEnvelope(body, secret, { eventType: "pull_request" });
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("ignore");
  });

  it("ignores non-created issue_comment actions", async () => {
    const body = JSON.stringify({ action: "edited" });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("ignore");
  });

  it("classifies PR-thread comments and preserves pull_request placement", async () => {
    const body = JSON.stringify({
      action: "created",
      sender: { login: "alice" },
      issue: {
        number: 7,
        title: "Investigate bridge behavior",
        html_url: "https://github.com/acme/app/issues/7",
        pull_request: { url: "https://api.github.com/repos/acme/app/pulls/7" },
      },
      comment: { id: 99, body: "@zapbot please summarize the PR state" },
    });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") {
      expect(r.value.kind).toBe("mention_request");
      if (r.value.kind === "mention_request") {
        expect(r.value.request.placement.issueThreadKind).toBe("pull_request");
        expect(r.value.request.rawCommentBody).toBe("@zapbot please summarize the PR state");
      }
    }
  });

  it("ignores self-mentions from the bot", async () => {
    const body = JSON.stringify({
      action: "created",
      sender: { login: "zapbot[bot]" },
      issue: { number: 1 },
      comment: { id: 99, body: "@zapbot please review this" },
    });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("ignore");
  });

  it("ignores comments with no bot mention", async () => {
    const body = JSON.stringify({
      action: "created",
      sender: { login: "alice" },
      issue: { number: 1 },
      comment: { id: 99, body: "no mention" },
    });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("ignore");
  });

  it("rejects a malformed issue_comment.created payload with PayloadShapeInvalid", async () => {
    // eventType=issue_comment, action=created, but `comment` object missing.
    const body = JSON.stringify({
      action: "created",
      sender: { login: "alice" },
      issue: { number: 7 },
      // comment: missing
    });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") {
      expect(r.error._tag).toBe("PayloadShapeInvalid");
      if (r.error._tag === "PayloadShapeInvalid") {
        expect(r.error.reason).toContain("comment");
      }
    }
  });

  it("ignores non-object payloads without surfacing an error", async () => {
    const body = "null";
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    // null is structurally invalid for issue_comment but we don't want to
    // 400 on it — gateway treats as decode failure → PayloadShapeInvalid.
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") expect(r.error._tag).toBe("PayloadShapeInvalid");
  });

  it("classifies a raw mention request with placement context", async () => {
    const body = JSON.stringify({
      action: "created",
      sender: { login: "alice" },
      issue: {
        number: 7,
        title: "Plan the next lane",
        html_url: "https://github.com/acme/app/issues/7",
      },
      comment: {
        id: 1234,
        body: "@zapbot please plan the next lane",
        html_url: "https://github.com/acme/app/issues/7#issuecomment-1234",
      },
    });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, resolveProjectName, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok" && r.value.kind === "mention_request") {
      expect(r.value.request.triggeredBy).toBe("alice");
      expect(r.value.request.placement.issue as unknown as number).toBe(7);
      expect(r.value.request.placement.commentId as unknown as number).toBe(1234);
      expect(r.value.request.placement.deliveryId as unknown as string).toBe("d-1");
      expect(r.value.request.placement.issueTitle).toBe("Plan the next lane");
      expect(r.value.request.placement.issueUrl).toBe("https://github.com/acme/app/issues/7");
      expect(r.value.request.placement.commentUrl).toBe("https://github.com/acme/app/issues/7#issuecomment-1234");
      expect(r.value.request.rawCommentBody).toBe("@zapbot please plan the next lane");
    } else {
      throw new Error("expected mention_request");
    }
  });
});
