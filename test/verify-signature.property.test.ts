import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { verifySignature } from "../src/http/verify-signature.js";

// Match verify-signature.ts byte-for-byte: WebCrypto HMAC-SHA256, hex, "sha256=" prefix.
async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

const RUNS = 200;

// Non-empty secret so the HMAC key is well-defined across both sides.
const arbSecret = fc.string({ minLength: 1, maxLength: 64 });
const arbBody = fc.string({ maxLength: 512 });

describe("verifySignature (property)", () => {
  it("accepts any correctly-signed payload", async () => {
    await fc.assert(
      fc.asyncProperty(arbSecret, arbBody, async (secret, body) => {
        const sig = await sign(body, secret);
        return (await verifySignature(body, sig, secret)) === true;
      }),
      { numRuns: RUNS }
    );
  });

  it("rejects a mutated signature", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSecret,
        arbBody,
        fc.nat(63), // position within the 64-hex-char digest
        fc.integer({ min: 1, max: 15 }), // nonzero XOR to guarantee change
        async (secret, body, hexIdx, xor) => {
          const sig = await sign(body, secret);
          const prefix = "sha256=";
          const hex = sig.slice(prefix.length);
          const originalNibble = parseInt(hex[hexIdx], 16);
          const mutatedNibble = (originalNibble ^ xor) & 0xf;
          const mutated =
            prefix +
            hex.slice(0, hexIdx) +
            mutatedNibble.toString(16) +
            hex.slice(hexIdx + 1);
          return (await verifySignature(body, mutated, secret)) === false;
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects a mutated body against the original signature", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSecret,
        arbBody,
        arbBody,
        async (secret, body, suffix) => {
          fc.pre(suffix.length > 0); // ensure the body actually changes
          const originalSig = await sign(body, secret);
          const mutatedBody = body + suffix;
          return (
            (await verifySignature(mutatedBody, originalSig, secret)) === false
          );
        }
      ),
      { numRuns: RUNS }
    );
  });

  it("rejects a mutated secret against the original signature", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSecret,
        arbBody,
        arbSecret,
        async (secret, body, otherSecret) => {
          fc.pre(otherSecret !== secret);
          const originalSig = await sign(body, secret);
          return (
            (await verifySignature(body, originalSig, otherSecret)) === false
          );
        }
      ),
      { numRuns: RUNS }
    );
  });
});
