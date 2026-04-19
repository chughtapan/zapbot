import { describe, it } from "vitest";
import * as fc from "fast-check";
import { verifyAndClassify, type GatewayWebhookEnvelope } from "../../v2/gateway.ts";
import { asDeliveryId, asRepoFullName, asBotUsername } from "../../v2/types.ts";
import type { RepoFullName } from "../../v2/types.ts";
import { sign } from "../helpers/sign.ts";

const RUNS = 100;
const BOT = asBotUsername("zapbot[bot]");

const arbSecret = fc.string({ minLength: 1, maxLength: 64 });
const arbRawBody = fc.string({ maxLength: 256 });
const arbRepo = fc
  .constantFrom("acme/app", "org/repo", "user/project")
  .map(asRepoFullName);
const arbNonIssueCommentEvent = fc
  .string({ minLength: 1, maxLength: 32 })
  .filter((s) => s !== "issue_comment");

function makeEnvelope(
  rawBody: string,
  signature: string | null,
  eventType: string,
  repo: RepoFullName
): GatewayWebhookEnvelope {
  return {
    rawBody,
    signature,
    eventType,
    deliveryId: asDeliveryId("prop-test-delivery"),
    repo,
    payload: {},
  };
}

describe("verifyAndClassify (property: broker routing)", () => {
  it("missing secret always yields SecretMissing regardless of payload or event", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRepo,
        arbRawBody,
        arbNonIssueCommentEvent,
        async (repo, rawBody, eventType) => {
          const envelope = makeEnvelope(rawBody, null, eventType, repo);
          const result = await verifyAndClassify(envelope, () => null, BOT);
          return result._tag === "Err" && result.error._tag === "SecretMissing";
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("null signature always yields SignatureMismatch when a secret exists", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRepo,
        arbSecret,
        arbRawBody,
        arbNonIssueCommentEvent,
        async (repo, secret, rawBody, eventType) => {
          const envelope = makeEnvelope(rawBody, null, eventType, repo);
          const result = await verifyAndClassify(envelope, () => secret, BOT);
          return result._tag === "Err" && result.error._tag === "SignatureMismatch";
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("non-issue_comment events with a valid signature always route to ignore", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRepo,
        arbSecret,
        arbRawBody,
        arbNonIssueCommentEvent,
        async (repo, secret, rawBody, eventType) => {
          const sig = await sign(rawBody, secret);
          const envelope = makeEnvelope(rawBody, sig, eventType, repo);
          const result = await verifyAndClassify(envelope, () => secret, BOT);
          return result._tag === "Ok" && result.value.kind === "ignore";
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("routing is deterministic: identical envelope and secret always yield the same outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbRepo,
        arbSecret,
        arbRawBody,
        fc.string({ minLength: 1, maxLength: 32 }),
        async (repo, secret, rawBody, eventType) => {
          const sig = await sign(rawBody, secret);
          const envelope = makeEnvelope(rawBody, sig, eventType, repo);
          const [r1, r2] = await Promise.all([
            verifyAndClassify(envelope, () => secret, BOT),
            verifyAndClassify(envelope, () => secret, BOT),
          ]);
          if (r1._tag !== r2._tag) return false;
          if (r1._tag === "Ok" && r2._tag === "Ok") return r1.value.kind === r2.value.kind;
          return true;
        }
      ),
      { numRuns: RUNS }
    );
  });
});
