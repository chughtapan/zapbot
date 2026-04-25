/**
 * test/integration/moltzap-app-role-pair — role-pair key routing.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 "architect posts via app-sdk conversation,
 * implementer consumes via MCP notification, bridge routes per manifest";
 * Invariants 6, 7.
 */

import { describe, it } from "vitest";

describe("moltzap app-sdk integration — role-pair routing", () => {
  it.todo(
    "architect sendOnKey('coord-implementer-to-architect'...) is rejected at send gate (wrong direction)",
  );
  it.todo(
    "implementer sendOnKey('coord-implementer-to-architect', parts) delivers to architect onMessage handler",
  );
  it.todo(
    "architect sendOnKey('coord-architect-peer', parts) delivers to a second architect's handler",
  );
  it.todo(
    "reviewer cannot register onMessageForKey('coord-architect-peer') — HandlerRegistrationError",
  );
  it.todo(
    "orchestrator sendOnKey('coord-orch-to-worker', parts) delivers to every worker",
  );
});
