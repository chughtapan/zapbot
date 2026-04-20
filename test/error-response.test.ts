import { describe, it, expect } from "vitest";
import { errorResponse } from "../v2/http/error-response.js";

describe("errorResponse", () => {
  it("returns correct status code", async () => {
    const resp = errorResponse(400, "invalid_request", "Bad input");
    expect(resp.status).toBe(400);
  });

  it("returns JSON body with error object", async () => {
    const resp = errorResponse(401, "authentication_error", "Not authed");
    const body = await resp.json();
    expect(body).toHaveProperty("error");
    expect(typeof body.error).toBe("object");
  });

  it("includes type, message, and status in error", async () => {
    const resp = errorResponse(403, "configuration_error", "Not configured");
    const { error } = await resp.json();
    expect(error.type).toBe("configuration_error");
    expect(error.message).toBe("Not configured");
    expect(error.status).toBe(403);
  });

  it("handles authentication_error type", async () => {
    const resp = errorResponse(401, "authentication_error", "Invalid key");
    const { error } = await resp.json();
    expect(error.type).toBe("authentication_error");
    expect(resp.status).toBe(401);
  });

  it("handles signature_error type", async () => {
    const resp = errorResponse(401, "signature_error", "Signature mismatch");
    const { error } = await resp.json();
    expect(error.type).toBe("signature_error");
  });

  it("handles not_found type", async () => {
    const resp = errorResponse(404, "not_found", "Resource not found.");
    const { error } = await resp.json();
    expect(error.type).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.message).toBe("Resource not found.");
  });
});
