/**
 * Generate a deterministic workflow ID from repo and issue number.
 * Format: wf-{owner}-{repo}-{issueNumber}
 */
export function makeWorkflowId(repo: string, issueNumber: number): string {
  return `wf-${repo.replace("/", "-")}-${issueNumber}`;
}
