import { describe, it, expect } from "vitest";
import { verifyAndClassify, type GatewayWebhookEnvelope } from "../src/gateway.ts";
import { asBotUsername, asDeliveryId, asRepoFullName } from "../src/types.ts";

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

  it("returns SecretMissing when resolveSecret returns null", async () => {
    const env = await buildEnvelope(JSON.stringify({ action: "created" }), secret);
    const r = await verifyAndClassify(env, () => null, bot);
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
    const r = await verifyAndClassify(env, () => secret, bot);
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") expect(r.error._tag).toBe("SignatureMismatch");
  });

  it("ignores non-issue_comment events", async () => {
    const body = JSON.stringify({ action: "opened" });
    const env = await buildEnvelope(body, secret, { eventType: "pull_request" });
    const r = await verifyAndClassify(env, () => secret, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("ignore");
  });

  it("ignores non-created issue_comment actions", async () => {
    const body = JSON.stringify({ action: "edited" });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok") expect(r.value.kind).toBe("ignore");
  });

  it("ignores self-mentions from the bot", async () => {
    const body = JSON.stringify({
      action: "created",
      sender: { login: "zapbot[bot]" },
      issue: { number: 1 },
      comment: { id: 99, body: "@zapbot plan this" },
    });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, bot);
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
    const r = await verifyAndClassify(env, () => secret, bot);
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
    const r = await verifyAndClassify(env, () => secret, bot);
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
    const r = await verifyAndClassify(env, () => secret, bot);
    // null is structurally invalid for issue_comment but we don't want to
    // 400 on it — gateway treats as decode failure → PayloadShapeInvalid.
    expect(r._tag).toBe("Err");
    if (r._tag === "Err") expect(r.error._tag).toBe("PayloadShapeInvalid");
  });

  it("classifies a plan_this mention", async () => {
    const body = JSON.stringify({
      action: "created",
      sender: { login: "alice" },
      issue: { number: 7 },
      comment: { id: 1234, body: "@zapbot plan this" },
    });
    const env = await buildEnvelope(body, secret);
    const r = await verifyAndClassify(env, () => secret, bot);
    expect(r._tag).toBe("Ok");
    if (r._tag === "Ok" && r.value.kind === "mention_command") {
      expect(r.value.command).toEqual({ kind: "plan_this" });
      expect(r.value.triggeredBy).toBe("alice");
      expect(r.value.issue as unknown as number).toBe(7);
      expect(r.value.commentId as unknown as number).toBe(1234);
      expect(r.value.deliveryId as unknown as string).toBe("d-1");
      expect(r.value.commentBody).toBe("@zapbot plan this");
    } else {
      throw new Error("expected mention_command");
    }
  });
});
