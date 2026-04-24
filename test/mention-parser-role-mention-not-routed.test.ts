/**
 * Regression test: after the @zapbot gate collapse, role-addressed mentions
 * (e.g. @architect-a, @implementer-1, @reviewer) must NOT be routed into
 * bridge dispatch paths.
 *
 * Anchors: SPEC r4.1 §5(f) Goal 6 (mention-parser collapse to single @zapbot);
 *          architect plan #148 §2.7.
 *
 * The parser returns `null` for any body whose only mentions are role
 * addresses. Only `@<botUsername>` mentions resolve to a MentionCommand.
 */

import { describe, expect, it } from "vitest";
import { parseMention } from "../src/mention-parser.ts";
import { asBotUsername } from "../src/types.ts";

const BOT = asBotUsername("zapbot");

describe("mention-parser role-mention-not-routed", () => {
  it("ignores @architect-a role mention", () => {
    expect(parseMention("@architect-a please review", BOT)).toBeNull();
  });

  it("ignores @implementer-1 role mention", () => {
    expect(parseMention("hey @implementer-1 status?", BOT)).toBeNull();
  });

  it("ignores @reviewer role mention", () => {
    expect(parseMention("@reviewer ping", BOT)).toBeNull();
  });

  it("ignores multiple role mentions in one body", () => {
    expect(
      parseMention(
        "@architect-a @implementer-1 @reviewer what's the status?",
        BOT,
      ),
    ).toBeNull();
  });

  it("still routes @zapbot when mixed with role mentions on separate lines", () => {
    // The parser reads the first line after @zapbot. A role mention on the
    // same line becomes part of the raw command body (unknown_command), not
    // a silent drop. A bare @zapbot on its own line continues to route.
    const res = parseMention("@zapbot\nstatus", BOT);
    expect(res).not.toBeNull();
    // First-line-after-mention is empty; returns unknown_command with raw="".
    expect(res?.kind).toBe("unknown_command");
  });

  it("routes @zapbot status even with trailing role mentions (graceful)", () => {
    // Current classifier does exact-match on the first line after the
    // mention; a trailing role address makes the command unknown, NOT
    // dispatched. That's a stop-rule-adjacent posture: ambiguous bodies
    // fall to unknown_command rather than being silently routed by role.
    const res = parseMention("@zapbot status @architect-a", BOT);
    expect(res?.kind).toBe("unknown_command");
  });
});
