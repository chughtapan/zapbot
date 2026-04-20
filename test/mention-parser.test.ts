import { describe, it, expect } from "vitest";
import { parseMention, stripQuotedContent } from "../src/mention-parser.ts";
import { asBotUsername } from "../src/types.ts";

const bot = asBotUsername("zapbot[bot]");

describe("stripQuotedContent", () => {
  it("strips fenced code blocks", () => {
    expect(stripQuotedContent("before\n```\n@zapbot plan this\n```\nafter")).not.toContain("@zapbot");
  });

  it("strips inline code", () => {
    expect(stripQuotedContent("see `@zapbot plan this` please")).not.toContain("@zapbot");
  });

  it("strips blockquote lines", () => {
    expect(stripQuotedContent("> @zapbot plan this\nhi")).not.toContain("@zapbot");
  });
});

describe("parseMention", () => {
  it("returns null without mention", () => {
    expect(parseMention("just a comment", bot)).toBeNull();
  });

  it("parses plan_this", () => {
    expect(parseMention("@zapbot plan this", bot)).toEqual({ kind: "plan_this" });
  });

  it("parses triage this as plan_this", () => {
    expect(parseMention("@zapbot triage this", bot)).toEqual({ kind: "plan_this" });
  });

  it("parses investigate_this", () => {
    expect(parseMention("@zapbot investigate this", bot)).toEqual({ kind: "investigate_this" });
  });

  it("parses bare investigate as investigate_this", () => {
    expect(parseMention("@zapbot investigate", bot)).toEqual({ kind: "investigate_this" });
  });

  it("parses status", () => {
    expect(parseMention("@zapbot status", bot)).toEqual({ kind: "status" });
  });

  it("returns unknown_command for unrecognized text", () => {
    expect(parseMention("@zapbot yodel", bot)).toEqual({ kind: "unknown_command", raw: "yodel" });
  });

  it("returns unknown_command with empty raw when mention has no tail", () => {
    expect(parseMention("@zapbot", bot)).toEqual({ kind: "unknown_command", raw: "" });
  });

  it("ignores quoted mentions", () => {
    expect(parseMention("> @zapbot plan this", bot)).toBeNull();
  });

  it("accepts @zapbot (without [bot] suffix)", () => {
    expect(parseMention("@zapbot status", bot)).toEqual({ kind: "status" });
  });

  it("is case-insensitive on the command", () => {
    expect(parseMention("@zapbot STATUS", bot)).toEqual({ kind: "status" });
  });
});
