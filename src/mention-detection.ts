import type { BotUsername, Result } from "./types.ts";
import { err, ok } from "./types.ts";

export interface EligibleBotMention {
  readonly _tag: "EligibleBotMention";
  readonly mentionText: string;
  readonly sanitizedBody: string;
}

export type MentionDetectionError =
  | { readonly _tag: "MentionBodyInvalid"; readonly reason: string }
  | { readonly _tag: "BotUsernameInvalid"; readonly reason: string };

export function stripQuotedContent(body: string): string {
  let stripped = body.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`]+`/g, "");
  stripped = stripped
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  return stripped;
}

export function detectEligibleBotMention(
  body: string,
  botUsername: BotUsername,
): Result<EligibleBotMention | null, MentionDetectionError> {
  if (body.length === 0) {
    return ok(null);
  }
  const baseName = (botUsername as unknown as string).replace(/\[bot\]$/, "").trim();
  if (baseName.length === 0) {
    return err({ _tag: "BotUsernameInvalid", reason: "bot username must be non-empty" });
  }
  const sanitizedBody = stripQuotedContent(body);
  const escaped = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionRe = new RegExp(`@${escaped}(?:\\[bot\\])?`, "i");
  const match = sanitizedBody.match(mentionRe);
  if (!match) {
    return ok(null);
  }
  return ok({
    _tag: "EligibleBotMention",
    mentionText: match[0],
    sanitizedBody,
  });
}
