/**
 * test/integration/moltzap-app-roster — end-to-end integration test.
 *
 * Anchors: sbd#170 SPEC rev 2, §5 integration-PR bullets on
 * `app.createSession({invitedAgentIds})` and 2-member roster round trip.
 *
 * Architect stage — `it.todo` entries declare the test surface. Bodies
 * land in implement-* stage.
 */

import { describe, it } from "vitest";

describe("moltzap app-sdk integration — roster session", () => {
  it.todo(
    "bridge constructs MoltZapApp with orchestrator manifest and starts session",
  );
  it.todo(
    "app.createSession({invitedAgentIds}) seeds conversation_participants for every manifest key",
  );
  it.todo(
    "second party not in invitedAgentIds is rejected at apps/create, not by the client",
  );
  it.todo(
    "session conversation map carries all 5 role-pair keys for the orchestrator manifest",
  );
});
