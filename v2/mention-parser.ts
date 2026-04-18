/**
 * v2/mention-parser — parse `@zapbot <command>` from a GitHub issue or PR
 * comment body into a discriminated `MentionCommand`.
 *
 * Boundary: text that arrived from a GitHub webhook payload. The webhook has
 * already been HMAC-verified before this module runs; the parser does NOT
 * validate authenticity, only shape.
 *
 * Principle 4 (Exhaustiveness): the return type is a discriminated union.
 * Callers must handle `unknown_command` explicitly (v1's `null` return is
 * replaced — "no command present" and "bot mentioned with unrecognized
 * command" are different cases and downstream reacts differently).
 */

import type { BotUsername, MentionCommand } from "./types.ts";

/**
 * Returns the parsed command if the body contains an `@<botUsername>` mention
 * on a line that is not inside a code fence / blockquote; returns `null` if
 * no bot mention is present at all.
 */
export function parseMention(
  _body: string,
  _botUsername: BotUsername
): MentionCommand | null {
  throw new Error("not implemented");
}

/**
 * Strip fenced code blocks, inline code, and blockquote lines from a body so
 * quoted mentions are not treated as commands. Exported for testing;
 * `parseMention` calls it internally.
 */
export function stripQuotedContent(_body: string): string {
  throw new Error("not implemented");
}
