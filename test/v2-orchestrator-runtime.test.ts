import { describe, expect, it } from "vitest";
import {
  ensureProjectOrchestrator,
  forwardControlPrompt,
  type AoControlHost,
} from "../v2/orchestrator/runtime.ts";
import { asAoSessionName, asProjectName, err, ok } from "../v2/types.ts";
import { asMoltzapSenderId } from "../v2/moltzap/types.ts";

describe("ensureProjectOrchestrator", () => {
  it("starts and resolves the persistent orchestrator", async () => {
    const calls: string[] = [];
    const host: AoControlHost = {
      ensureStarted: async () => {
        calls.push("ensureStarted");
        return ok(undefined);
      },
      resolveReady: async () => {
        calls.push("resolveReady");
        return ok({
          session: asAoSessionName("app-orchestrator"),
          senderId: asMoltzapSenderId("orch-1"),
          mode: "started",
        });
      },
      sendPrompt: async () => ok(undefined),
    };
    const result = await ensureProjectOrchestrator(asProjectName("app"), host);
    expect(result._tag).toBe("Ok");
    expect(calls).toEqual(["ensureStarted", "resolveReady"]);
  });
});

describe("forwardControlPrompt", () => {
  it("sends the rendered prompt to the ready orchestrator session", async () => {
    const sent: Array<{ session: string; title: string }> = [];
    const host: AoControlHost = {
      ensureStarted: async () => ok(undefined),
      resolveReady: async () =>
        ok({
          session: asAoSessionName("app-orchestrator"),
          senderId: asMoltzapSenderId("orch-1"),
          mode: "reused",
        }),
      sendPrompt: async (session, prompt) => {
        sent.push({ session, title: prompt.title });
        return ok(undefined);
      },
    };
    const result = await forwardControlPrompt(
      asProjectName("app"),
      { title: "hello", body: "body" },
      host,
    );
    expect(result).toEqual({
      _tag: "Ok",
      value: {
        session: "app-orchestrator",
        senderId: "orch-1",
      },
    });
    expect(sent).toEqual([{ session: "app-orchestrator", title: "hello" }]);
  });

  it("bubbles AoSendFailed as a typed error", async () => {
    const host: AoControlHost = {
      ensureStarted: async () => ok(undefined),
      resolveReady: async () =>
        ok({
          session: asAoSessionName("app-orchestrator"),
          senderId: asMoltzapSenderId("orch-1"),
          mode: "reused",
        }),
      sendPrompt: async () => err({ _tag: "AoSendFailed", cause: "pipe closed" }),
    };
    const result = await forwardControlPrompt(
      asProjectName("app"),
      { title: "hello", body: "body" },
      host,
    );
    expect(result).toEqual({
      _tag: "Err",
      error: { _tag: "AoSendFailed", cause: "pipe closed" },
    });
  });
});
