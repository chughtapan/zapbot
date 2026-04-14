import type { SideEffect } from "../state-machine/effects.js";
import { createLogger } from "../logger.js";

const log = createLogger("effects");

/** GitHub API effects that are safe to retry on failure. */
const RETRYABLE_EFFECTS = new Set([
  "add_label", "remove_label", "post_comment", "close_issue",
  "convert_pr_to_draft", "create_sub_issue",
]);

export interface EffectResult {
  effect: SideEffect;
  success: boolean;
  retried: boolean;
  error?: string;
}

/**
 * Execute a single side effect with retry for GitHub API effects.
 * Retries once after 2s delay if the first attempt fails.
 */
export async function executeWithRetry(
  effect: SideEffect,
  executor: (effect: SideEffect) => Promise<void>
): Promise<EffectResult> {
  try {
    await executor(effect);
    return { effect, success: true, retried: false };
  } catch (err) {
    if (!RETRYABLE_EFFECTS.has(effect.type)) {
      log.error(`Non-retryable effect ${effect.type} failed: ${err}`);
      return { effect, success: false, retried: false, error: String(err) };
    }

    log.warn(`Effect ${effect.type} failed, retrying in 2s: ${err}`);
    await new Promise((r) => setTimeout(r, 2000));

    try {
      await executor(effect);
      log.info(`Effect ${effect.type} succeeded on retry`);
      return { effect, success: true, retried: true };
    } catch (retryErr) {
      log.error(`Effect ${effect.type} failed after retry: ${retryErr}`);
      return { effect, success: false, retried: true, error: String(retryErr) };
    }
  }
}

/**
 * Build a reconciliation comment for failed effects.
 * Returns null if no failures.
 */
export function buildReconciliationComment(failures: EffectResult[]): string | null {
  if (failures.length === 0) return null;

  const lines = failures.map((f) =>
    `- \`${f.effect.type}\`: ${f.error || "unknown error"}`
  );

  return [
    "Zapbot: Some side effects failed after retry. The workflow state in the database may differ from GitHub.",
    "",
    "**Failed effects:**",
    ...lines,
    "",
    "Check the bridge logs for details.",
  ].join("\n");
}
