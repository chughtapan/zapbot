import { createLogger } from "../logger.js";

const log = createLogger("session-lookup");

/**
 * Find the AO session name for a given issue number by parsing `ao session ls` output.
 * Looks for lines containing the branch pattern `feat/issue-{N}`.
 */
export async function findSessionForIssue(issueNumber: number): Promise<string | null> {
  const branch = `feat/issue-${issueNumber}`;

  for (const cmd of [["ao", "session", "ls"], ["ao", "status"]]) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        log.warn(`${cmd.join(" ")} exited with code ${exitCode}`, { branch });
        continue;
      }
      for (const line of stdout.split("\n")) {
        if (line.includes(branch)) {
          const match = line.match(/(zap-\d+)/);
          if (match) return match[1];
        }
      }
    } catch (err) {
      log.warn(`${cmd.join(" ")} threw: ${err}`, { branch });
    }
  }

  log.warn(`Could not find AO session for ${branch}`, { issueNumber });
  return null;
}
