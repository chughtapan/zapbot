import { describe, it } from "vitest";

/**
 * Stubbed test surface. Bodies are `implement-*`'s scope.
 * Traceability: zap#134 acceptance → each `it.todo` below.
 */

describe("supervisor / computeBackoff", () => {
  it.todo("attempt=0 returns jittered value in [0, initialMs]");
  it.todo("attempt=N returns jittered value in [0, min(capMs, initialMs*2^N)]");
  it.todo("delay never exceeds capMs regardless of attempt count");
});

describe("supervisor / step — retry path", () => {
  it.todo("Active(FAILED) with attempts<max → Backoff + ScheduleRetry action");
  it.todo("Active(FAILED) with attempts=max-1 → GaveUp(MaxAttemptsExhausted) + ReportGaveUp");
  it.todo("Backoff + BackoffElapsed → Active(INIT) + StartAttempt (attempts incremented)");
  it.todo("Active(LISTENING) resets attempts counter to 0");
  it.todo("freshAttempt returns lifecycle=INIT (I7: no buffered state carries over)");
});

describe("supervisor / step — drain path", () => {
  it.todo("Active + DrainRequested → Draining (any inner lifecycle state)");
  it.todo("Backoff + DrainRequested → Draining (timer cancellation implied by action=None)");
  it.todo("Draining + Stopped → GaveUp(DrainCompleted)");
  it.todo("GaveUp is terminal — further events return Illegal");
});

describe("supervisor / I7 structural check", () => {
  it.todo("no SupervisorState tag carries a MoltzapInbound/conversationId/messageId field");
});

describe("supervisor / probes", () => {
  it.todo("supervisorIsListening true iff Active.lifecycle._tag === LISTENING");
  it.todo("supervisorIsTerminal true iff _tag === GaveUp");
});
