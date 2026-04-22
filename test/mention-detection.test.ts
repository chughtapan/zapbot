import { describe, it, expect } from "vitest";
import { detectEligibleBotMention, stripQuotedContent } from "../src/mention-detection.ts";
import { asBotUsername } from "../src/types.ts";

const bot = asBotUsername("zapbot[bot]");

describe("stripQuotedContent", () => {
  it("strips fenced code blocks", () => {
    expect(stripQuotedContent("before\n```\n@zapbot please look at this\n```\nafter")).not.toContain("@zapbot");
  });

  it("strips inline code", () => {
    expect(stripQuotedContent("see `@zapbot please look at this` please")).not.toContain("@zapbot");
  });

  it("strips blockquote lines", () => {
    expect(stripQuotedContent("> @zapbot please look at this\nhi")).not.toContain("@zapbot");
  });
});

describe("detectEligibleBotMention", () => {
  it("returns null without mention", () => {
    const result = detectEligibleBotMention("just a comment", bot);
    expect(result).toEqual({ _tag: "Ok", value: null });
  });

  it("accepts a bare mention", () => {
    const result = detectEligibleBotMention("@zapbot", bot);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok") return;
    expect(result.value?._tag).toBe("EligibleBotMention");
  });

  it("accepts arbitrary raw text after the mention", () => {
    const result = detectEligibleBotMention("@zapbot yodel at the moon", bot);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok" || result.value === null) return;
    expect(result.value.mentionText.toLowerCase()).toContain("@zapbot");
    expect(result.value.sanitizedBody).toContain("yodel at the moon");
  });

  it("ignores quoted mentions", () => {
    const result = detectEligibleBotMention("> @zapbot please look", bot);
    expect(result).toEqual({ _tag: "Ok", value: null });
  });

  it("accepts @zapbot without the [bot] suffix", () => {
    const result = detectEligibleBotMention("@zapbot status me if needed", bot);
    expect(result._tag).toBe("Ok");
    if (result._tag !== "Ok" || result.value === null) return;
    expect(result.value.mentionText).toBe("@zapbot");
  });
});
