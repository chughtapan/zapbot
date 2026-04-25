/**
 * test/integration/moltzap-app-addparticipant — late-joiner admission.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 roster-growth bullet; Invariant 11;
 * Non-goal 8; Spike A verdict (sbd#181).
 */

import { describe, it } from "vitest";

describe("moltzap app-sdk integration — late-joiner conversation admission", () => {
  it.todo(
    "admitLateJoiner called from bridge adds joiner to conversation_participants for every receivable+sendable key of joiner role",
  );
  it.todo(
    "admitLateJoiner result reports admittedAtSessionLevel=false (v1 scope)",
  );
  it.todo(
    "late joiner receives WS messages posted on admitted keys after admission",
  );
  it.todo(
    "late joiner is NOT listed by apps/getSession (Invariant 11)",
  );
  it.todo(
    "admitLateJoiner called from a non-initiator process returns NotInitiator error",
  );
});
