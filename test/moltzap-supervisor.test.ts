import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  asAttemptCount,
  asDelayMs,
  asWallClockMs,
  computeBackoff,
  freshAttempt,
  step,
  supervisorIsListening,
  supervisorIsTerminal,
  type BackoffPolicy,
  type Clock,
  type SupervisorState,
} from "../src/moltzap/supervisor.ts";
import type { LifecycleState } from "../src/moltzap/lifecycle.ts";
import type { ListenerHandle } from "../src/moltzap/types.ts";

const LISTENER = { __brand: "ListenerHandle" } as ListenerHandle;

function makeClock(now = 10_000, jitter = (_maxMs: number) => 250): Clock {
  return {
    now: () => asWallClockMs(now),
    randomJitter: (maxMs) => asDelayMs(jitter(Number(maxMs))),
  };
}

function failedLifecycle(cause: unknown = "boom"): LifecycleState {
  return {
    _tag: "FAILED",
    cause: { _tag: "MoltzapHandshakeError", cause },
  };
}

describe("supervisor / computeBackoff", () => {
  it("attempt=0 returns a jittered value in [0, initialMs]", () => {
    const policy: BackoffPolicy = {
      initialMs: asDelayMs(1_000),
      capMs: asDelayMs(60_000),
      maxAttempts: asAttemptCount(8),
    };
    const delay = computeBackoff(asAttemptCount(0), policy, makeClock(0, () => 500));
    expect(delay).toBe(500);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(policy.initialMs);
  });

  it("attempt=N returns a jittered value in [0, min(capMs, initialMs*2^N)]", () => {
    const policy: BackoffPolicy = {
      initialMs: asDelayMs(1_000),
      capMs: asDelayMs(60_000),
      maxAttempts: asAttemptCount(8),
    };
    const delay = computeBackoff(asAttemptCount(3), policy, makeClock(0, () => 7_500));
    expect(delay).toBe(7_500);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(8_000);
  });

  it("delay never exceeds capMs regardless of attempt count", () => {
    const policy: BackoffPolicy = {
      initialMs: asDelayMs(1_000),
      capMs: asDelayMs(3_000),
      maxAttempts: asAttemptCount(8),
    };
    const delay = computeBackoff(asAttemptCount(10), policy, makeClock(0, () => 99_999));
    expect(delay).toBe(3_000);
  });
});

describe("supervisor / step — retry path", () => {
  it("Active(FAILED) with attempts<max → Backoff + ScheduleRetry action", () => {
    const clock = makeClock(2_000, () => 700);
    const result = step(
      { _tag: "Active", attempts: asAttemptCount(0), lifecycle: { _tag: "INIT" } },
      { _tag: "LifecycleProgressed", state: failedLifecycle("timeout") },
      DEFAULT_POLICY,
      clock,
    );
    expect(result._tag).toBe("Next");
    if (result._tag !== "Next") return;
    expect(result.state._tag).toBe("Backoff");
    if (result.state._tag !== "Backoff") return;
    expect(result.state.attempts).toBe(0);
    expect(result.state.waitUntilMs).toBe(2_700);
    expect(result.action).toEqual({
      _tag: "ScheduleRetry",
      delayMs: asDelayMs(700),
      firesAtMs: asWallClockMs(2_700),
    });
  });

  it("Active(FAILED) with attempts=max-1 → GaveUp(MaxAttemptsExhausted) + ReportGaveUp", () => {
    const policy: BackoffPolicy = {
      initialMs: asDelayMs(1_000),
      capMs: asDelayMs(60_000),
      maxAttempts: asAttemptCount(2),
    };
    const result = step(
      { _tag: "Active", attempts: asAttemptCount(1), lifecycle: { _tag: "MOLTZAP_READY" } },
      { _tag: "LifecycleProgressed", state: failedLifecycle("still broken") },
      policy,
      makeClock(),
    );
    expect(result._tag).toBe("Next");
    if (result._tag !== "Next") return;
    expect(result.state._tag).toBe("GaveUp");
    expect(result.action._tag).toBe("ReportGaveUp");
    if (result.action._tag !== "ReportGaveUp") return;
    expect(result.action.cause._tag).toBe("MaxAttemptsExhausted");
    if (result.action.cause._tag !== "MaxAttemptsExhausted") return;
    expect(result.action.cause.attempts).toBe(1);
  });

  it("Backoff + BackoffElapsed → Active(INIT) + StartAttempt (attempts incremented)", () => {
    const result = step(
      {
        _tag: "Backoff",
        attempts: asAttemptCount(1),
        waitUntilMs: asWallClockMs(9_000),
        lastCause: { _tag: "TransportConnectError", cause: "stdio broke" },
      },
      { _tag: "BackoffElapsed" },
      DEFAULT_POLICY,
      makeClock(),
    );
    expect(result._tag).toBe("Next");
    if (result._tag !== "Next") return;
    expect(result.state).toEqual({
      _tag: "Active",
      attempts: asAttemptCount(2),
      lifecycle: { _tag: "INIT" },
    });
    expect(result.action).toEqual({
      _tag: "StartAttempt",
      attempts: asAttemptCount(2),
    });
  });

  it("Active(LISTENING) resets attempts counter to 0", () => {
    const result = step(
      {
        _tag: "Active",
        attempts: asAttemptCount(4),
        lifecycle: { _tag: "MOLTZAP_READY" },
      },
      {
        _tag: "LifecycleProgressed",
        state: { _tag: "LISTENING", listener: LISTENER },
      },
      DEFAULT_POLICY,
      makeClock(),
    );
    expect(result._tag).toBe("Next");
    if (result._tag !== "Next") return;
    expect(result.state).toEqual({
      _tag: "Active",
      attempts: asAttemptCount(0),
      lifecycle: { _tag: "LISTENING", listener: LISTENER },
    });
  });

  it("freshAttempt returns lifecycle=INIT (I7: no buffered state carries over)", () => {
    const result = freshAttempt(asAttemptCount(5));
    expect(result._tag).toBe("Ok");
    expect(result.value).toEqual({
      attempts: asAttemptCount(6),
      lifecycle: { _tag: "INIT" },
    });
  });
});

describe("supervisor / step — drain path", () => {
  it("Active + DrainRequested → Draining (any inner lifecycle state)", () => {
    const result = step(
      {
        _tag: "Active",
        attempts: asAttemptCount(2),
        lifecycle: { _tag: "STDIO_READY" },
      },
      { _tag: "DrainRequested", reason: { _tag: "SigTerm" } },
      DEFAULT_POLICY,
      makeClock(),
    );
    expect(result).toEqual({
      _tag: "Next",
      state: { _tag: "Draining", reason: { _tag: "SigTerm" } },
      action: { _tag: "None" },
    });
  });

  it("Backoff + DrainRequested → Draining (timer cancellation implied by action=None)", () => {
    const result = step(
      {
        _tag: "Backoff",
        attempts: asAttemptCount(0),
        waitUntilMs: asWallClockMs(12_000),
        lastCause: { _tag: "TransportConnectError", cause: "stdio broke" },
      },
      { _tag: "DrainRequested", reason: { _tag: "MoltzapDisconnect" } },
      DEFAULT_POLICY,
      makeClock(),
    );
    expect(result).toEqual({
      _tag: "Next",
      state: { _tag: "Draining", reason: { _tag: "MoltzapDisconnect" } },
      action: { _tag: "None" },
    });
  });

  it("Draining + Stopped → GaveUp(DrainCompleted)", () => {
    const result = step(
      { _tag: "Draining", reason: { _tag: "McpDisconnect" } },
      { _tag: "Stopped" },
      DEFAULT_POLICY,
      makeClock(),
    );
    expect(result._tag).toBe("Next");
    if (result._tag !== "Next") return;
    expect(result.state._tag).toBe("GaveUp");
    expect(result.action._tag).toBe("ReportGaveUp");
    if (result.action._tag !== "ReportGaveUp") return;
    expect(result.action.cause).toEqual({
      _tag: "DrainCompleted",
      reason: { _tag: "McpDisconnect" },
    });
  });

  it("GaveUp is terminal — further events return Illegal", () => {
    const terminal: SupervisorState = {
      _tag: "GaveUp",
      cause: {
        _tag: "MaxAttemptsExhausted",
        attempts: asAttemptCount(7),
        lastCause: { _tag: "TransportConnectError", cause: "stdio broke" },
      },
    };
    const result = step(
      terminal,
      { _tag: "BackoffElapsed" },
      DEFAULT_POLICY,
      makeClock(),
    );
    expect(result).toEqual({
      _tag: "Illegal",
      from: terminal,
      event: { _tag: "BackoffElapsed" },
    });
  });
});

describe("supervisor / I7 structural check", () => {
  it("no SupervisorState tag carries a MoltzapInbound/conversationId/messageId field", () => {
    const states: SupervisorState[] = [
      { _tag: "Active", attempts: asAttemptCount(0), lifecycle: { _tag: "INIT" } },
      {
        _tag: "Active",
        attempts: asAttemptCount(1),
        lifecycle: { _tag: "LISTENING", listener: LISTENER },
      },
      {
        _tag: "Backoff",
        attempts: asAttemptCount(2),
        waitUntilMs: asWallClockMs(15_000),
        lastCause: { _tag: "MoltzapHandshakeError", cause: "timeout" },
      },
      { _tag: "Draining", reason: { _tag: "SigTerm" } },
    ];
    for (const state of states) {
      const json = JSON.stringify(state);
      expect(json).not.toContain("messageId");
      expect(json).not.toContain("conversationId");
      expect(json).not.toContain("senderId");
      expect(json).not.toContain("bodyText");
    }
  });
});

describe("supervisor / probes", () => {
  it("supervisorIsListening true iff Active.lifecycle._tag === LISTENING", () => {
    expect(
      supervisorIsListening({
        _tag: "Active",
        attempts: asAttemptCount(0),
        lifecycle: { _tag: "LISTENING", listener: LISTENER },
      }),
    ).toBe(true);
    expect(
      supervisorIsListening({
        _tag: "Active",
        attempts: asAttemptCount(0),
        lifecycle: { _tag: "MOLTZAP_READY" },
      }),
    ).toBe(false);
    expect(
      supervisorIsListening({
        _tag: "Backoff",
        attempts: asAttemptCount(0),
        waitUntilMs: asWallClockMs(5_000),
        lastCause: { _tag: "TransportConnectError", cause: "boom" },
      }),
    ).toBe(false);
  });

  it("supervisorIsTerminal true iff _tag === GaveUp", () => {
    expect(
      supervisorIsTerminal({
        _tag: "GaveUp",
        cause: {
          _tag: "DrainCompleted",
          reason: { _tag: "SigTerm" },
        },
      }),
    ).toBe(true);
    expect(
      supervisorIsTerminal({
        _tag: "Draining",
        reason: { _tag: "SigTerm" },
      }),
    ).toBe(false);
  });
});
