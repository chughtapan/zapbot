import { describe, it, expect } from "vitest";
import { verifySignature } from "../v2/http/verify-signature.js";

// Helper: compute a valid sha256 HMAC signature the same way GitHub does
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

describe("verifySignature", () => {
  const secret = "test-webhook-secret";
  const payload = '{"action":"opened"}';

  it("returns true for a valid signature", async () => {
    const sig = await sign(payload, secret);
    expect(await verifySignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", async () => {
    const sig = await sign(payload, secret);
    // Flip last character
    const bad = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(await verifySignature(payload, bad, secret)).toBe(false);
  });

  it("returns false when signature is null", async () => {
    expect(await verifySignature(payload, null, secret)).toBe(false);
  });

  it("returns false when signature has wrong length", async () => {
    expect(await verifySignature(payload, "sha256=tooshort", secret)).toBe(false);
  });

  it("returns false when secret does not match", async () => {
    const sig = await sign(payload, "wrong-secret");
    expect(await verifySignature(payload, sig, secret)).toBe(false);
  });
});
