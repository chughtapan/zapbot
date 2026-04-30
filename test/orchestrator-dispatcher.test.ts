/**
 * Tests for `src/orchestrator/dispatcher.ts` (sub-issue #375).
 *
 * Drives `runTurn` against a stubbed `fetch` so the bridge → orchestrator
 * HTTP seam is exercised without spinning up a real listener. Covers the
 * invariants the architect audit named:
 *
 *   - bearer auth on every request
 *   - request body shape (projectSlug, deliveryId, message, githubToken)
 *   - GH_TOKEN passthrough end-to-end (the `githubToken` field is
 *     forwarded verbatim, never re-derived inside the dispatcher)
 *   - idempotent dispatch over duplicate deliveryIds (the orchestrator
 *     responds `DuplicateDelivery`; the dispatcher round-trips it)
 *   - 401 → OrchestratorAuthFailed; 5xx FleetSpawnFailed body →
 *     FleetSpawnFailed; network error → OrchestratorUnreachable.
 */

import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  runTurn,
  type DispatchTurnRequest,
  type DispatcherDeps,
} from "../src/orchestrator/dispatcher.ts";

const REQUEST: DispatchTurnRequest = {
  projectSlug: "app",
  deliveryId: "delivery-1",
  message: "hello",
  githubToken: "ghs_test_token",
};

function makeDeps(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<DispatcherDeps> = {},
): DispatcherDeps {
  return {
    orchestratorUrl: overrides.orchestratorUrl ?? "http://127.0.0.1:3002",
    orchestratorSecret: overrides.orchestratorSecret ?? "shared-secret",
    fetch: fetchImpl,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runTurn — request shape", () => {
  it("POSTs to /turn with bearer auth, JSON body, and the request fields verbatim", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch: typeof globalThis.fetch = async (url, init) => {
      captured.url = String(url);
      captured.init = init;
      return jsonResponse(
        { tag: "Replied", newSessionId: "sess-1", durationMs: 12 },
        200,
      );
    };

    const result = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST),
    );

    expect(captured.url).toBe("http://127.0.0.1:3002/turn");
    expect(captured.init?.method).toBe("POST");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer shared-secret");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(captured.init?.body as string) as DispatchTurnRequest;
    expect(body).toEqual(REQUEST);
    // GH_TOKEN passthrough invariant: the dispatcher does not mutate the
    // installation token; it rides the request body byte-for-byte.
    expect(body.githubToken).toBe(REQUEST.githubToken);
    expect(result).toEqual({
      tag: "Replied",
      newSessionId: "sess-1",
      durationMs: 12,
    });
  });

  it("trims trailing slashes from orchestratorUrl when building the /turn URL", async () => {
    let calledUrl = "";
    const fakeFetch: typeof globalThis.fetch = async (url) => {
      calledUrl = String(url);
      return jsonResponse(
        { tag: "Replied", newSessionId: "sess-1", durationMs: 1 },
        200,
      );
    };
    await Effect.runPromise(
      runTurn(
        makeDeps(fakeFetch, { orchestratorUrl: "http://127.0.0.1:3002///" }),
        REQUEST,
      ),
    );
    expect(calledUrl).toBe("http://127.0.0.1:3002/turn");
  });
});

describe("runTurn — happy-path response decoding", () => {
  it("decodes a 200 Replied response into the typed union", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse(
        { tag: "Replied", newSessionId: "sess-42", durationMs: 100 },
        200,
      );
    const out = await Effect.runPromise(runTurn(makeDeps(fakeFetch), REQUEST));
    expect(out).toEqual({
      tag: "Replied",
      newSessionId: "sess-42",
      durationMs: 100,
    });
  });

  it("decodes a 200 DuplicateDelivery response (idempotency over redelivery)", async () => {
    // Same deliveryId on the second hit → the orchestrator short-circuits
    // and returns DuplicateDelivery. The dispatcher round-trips it without
    // re-invoking claude. This is the bridge's idempotency proof.
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse(
        { tag: "DuplicateDelivery", priorSessionId: "sess-prior" },
        200,
      );
    const out = await Effect.runPromise(runTurn(makeDeps(fakeFetch), REQUEST));
    expect(out).toEqual({
      tag: "DuplicateDelivery",
      priorSessionId: "sess-prior",
    });
  });
});

describe("runTurn — error mapping", () => {
  it("network failure surfaces OrchestratorUnreachable with the cause", async () => {
    const fakeFetch: typeof globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED 127.0.0.1:3002");
    };
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left._tag).toBe("OrchestratorUnreachable");
    if (exit.left._tag !== "OrchestratorUnreachable") return;
    expect(exit.left.url).toBe("http://127.0.0.1:3002/turn");
    expect(exit.left.cause).toContain("ECONNREFUSED");
  });

  it("401 OrchestratorAuthFailed body decodes into the matching tag", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse(
        { error: "OrchestratorAuthFailed", reason: "secret-mismatch" },
        401,
      );
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left).toEqual({
      _tag: "OrchestratorAuthFailed",
      reason: "secret-mismatch",
    });
  });

  it("503 FleetSpawnFailed body decodes into the matching tag", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse(
        {
          error: "FleetSpawnFailed",
          agentName: "worker-1",
          cause: "ready-timeout",
          detail: "agent did not authenticate within 60s",
        },
        503,
      );
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left).toEqual({
      _tag: "FleetSpawnFailed",
      agentName: "worker-1",
      cause: "ready-timeout",
      detail: "agent did not authenticate within 60s",
    });
  });

  it("503 LeadSessionCorrupted body decodes into the matching tag", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse(
        {
          error: "LeadSessionCorrupted",
          projectSlug: "app",
          sessionPath: "/tmp/session.json",
          reason: "JSON parse failed",
        },
        503,
      );
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left).toEqual({
      _tag: "LeadSessionCorrupted",
      projectSlug: "app",
      sessionPath: "/tmp/session.json",
      reason: "JSON parse failed",
    });
  });

  it("429 LockTimeout body decodes into the matching tag", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse(
        { error: "LockTimeout", projectSlug: "app", waitedMs: 30000 },
        429,
      );
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left).toEqual({
      _tag: "LockTimeout",
      projectSlug: "app",
      waitedMs: 30000,
    });
  });

  it("downgrades non-JSON 5xx body to OrchestratorUnreachable (response no longer typed)", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      new Response("internal server error", { status: 500 });
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left._tag).toBe("OrchestratorUnreachable");
  });

  it("downgrades 200 response with malformed body to OrchestratorUnreachable", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse({ tag: "NotARealVariant" }, 200);
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left._tag).toBe("OrchestratorUnreachable");
  });

  it("downgrades unknown 4xx error tags to OrchestratorUnreachable", async () => {
    const fakeFetch: typeof globalThis.fetch = async () =>
      jsonResponse({ error: "SomethingTheBridgeDoesNotKnow" }, 418);
    const exit = await Effect.runPromise(
      runTurn(makeDeps(fakeFetch), REQUEST).pipe(Effect.either),
    );
    expect(exit._tag).toBe("Left");
    if (exit._tag !== "Left") return;
    expect(exit.left._tag).toBe("OrchestratorUnreachable");
    if (exit.left._tag !== "OrchestratorUnreachable") return;
    expect(exit.left.cause).toContain("SomethingTheBridgeDoesNotKnow");
  });
});
