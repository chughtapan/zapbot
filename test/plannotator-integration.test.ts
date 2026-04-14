import { describe, it, expect } from "vitest";

describe("plannotator integration", () => {
  it("plannotator annotate produces a share URL", async () => {
    const tempFile = `/tmp/zapbot-test-plan-${Date.now()}.md`;
    await Bun.write(tempFile, "# Test Plan\n\nThis is a test plan.\n");

    try {
      // plannotator annotate prints the URL then starts a local server (blocks).
      // Use timeout to kill after the URL is printed.
      const proc = Bun.spawn(["timeout", "10", "plannotator", "annotate", tempFile], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      await proc.exited; // exit 124 (timeout) is expected

      const combined = stdout + stderr;
      expect(combined).toContain("https://share.plannotator.ai/");
      expect(combined).not.toContain("Failed to parse hook event");
    } finally {
      try { require("fs").unlinkSync(tempFile); } catch {}
    }
  }, 15000); // 15s timeout for vitest (plannotator needs ~10s to timeout)

  it("plannotator binary does not use nonexistent 'share' subcommand", async () => {
    // Verify our code doesn't reference the old broken subcommand
    const publishScript = await Bun.file("bin/zapbot-publish.sh").text();
    expect(publishScript).not.toContain("plannotator share");
    expect(publishScript).toContain("plannotator annotate");

    const skillMd = await Bun.file("skills/zapbot-publish/SKILL.md").text();
    expect(skillMd).not.toContain("plannotator share");
    expect(skillMd).toContain("plannotator annotate");
  });
});

describe("callback endpoint contract", () => {
  it("plan_published callback requires token field", async () => {
    // This validates the callback contract that zapbot-publish uses.
    // The bridge requires: body.token (string), and the token must be
    // registered via POST /api/tokens first.
    // Without a running bridge, we validate the contract is documented correctly.
    const skillMd = await Bun.file("skills/zapbot-publish/SKILL.md").text();

    // Step 10 should register a token
    expect(skillMd).toContain("/api/tokens");
    expect(skillMd).toContain("Authorization: Bearer");

    // Step 11 should send the callback with the token
    expect(skillMd).toContain("/api/callbacks/plannotator/");
    expect(skillMd).toContain("plan_published");
  });
});
