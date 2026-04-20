/**
 * mention-parser — parse `@zapbot <command>` from a comment body.
 */

import type { BotUsername, MentionCommand } from "./types.ts";

/**
 * Strip fenced code blocks, inline code, and blockquote lines so quoted
 * mentions are not treated as commands.
 */
export function stripQuotedContent(body: string): string {
  let stripped = body.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`]+`/g, "");
  stripped = stripped
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  return stripped;
}

function buildMentionRegex(botUsername: string): RegExp {
  const baseName = botUsername.replace(/\[bot\]$/, "");
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${escaped}(?:\\[bot\\])?`, "i");
}

function classify(raw: string): MentionCommand {
  const lower = raw.toLowerCase().trim();
  if (lower === "plan this" || lower === "triage this") {
    return { kind: "plan_this" };
  }
  if (lower === "investigate this" || lower === "investigate") {
    return { kind: "investigate_this" };
  }
  if (lower === "status") {
    return { kind: "status" };
  }
  return { kind: "unknown_command", raw };
}

/**
 * Returns the parsed command if the body contains an `@<botUsername>` mention
 * on a line that is not inside a code fence or blockquote. Returns `null` if
 * no bot mention is present at all.
 */
export function parseMention(
  body: string,
  botUsername: BotUsername
): MentionCommand | null {
  const cleaned = stripQuotedContent(body);
  const mentionRe = buildMentionRegex(botUsername as unknown as string);
  const match = cleaned.match(mentionRe);
  if (!match || match.index === undefined) return null;
  const afterMention = cleaned.slice(match.index + match[0].length);
  const firstLine = afterMention.split("\n")[0].trim();
  if (!firstLine) {
    return { kind: "unknown_command", raw: "" };
  }
  return classify(firstLine);
}
