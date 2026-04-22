import type { BotUsername, Result } from "./types.ts";

export interface EligibleBotMention {
  readonly _tag: "EligibleBotMention";
  readonly mentionText: string;
  readonly sanitizedBody: string;
}

export type MentionDetectionError =
  | { readonly _tag: "MentionBodyInvalid"; readonly reason: string }
  | { readonly _tag: "BotUsernameInvalid"; readonly reason: string };

export function stripQuotedContent(body: string): string {
  throw new Error("not implemented");
}

export function detectEligibleBotMention(
  body: string,
  botUsername: BotUsername,
): Result<EligibleBotMention | null, MentionDetectionError> {
  throw new Error("not implemented");
}
