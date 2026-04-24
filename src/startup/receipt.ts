import { err, ok, type Result } from "../types.ts";
import type { IngressPolicy } from "../config/ingress.ts";

export type StartupReceiptError =
  | { readonly _tag: "MissingProjectDir" }
  | { readonly _tag: "MissingRepoList" }
  | { readonly _tag: "UnsupportedReceiptMode"; readonly mode: string };

export interface StartupReceiptInput {
  readonly projectDir: string;
  readonly repos: ReadonlyArray<string>;
  readonly ingress: IngressPolicy;
  readonly bridgePort: number;
  readonly dashboardPort: number;
  readonly gatewayUrl: string | null;
  readonly publicUrl: string | null;
  readonly logsPath: string;
  readonly publishCommand: string;
}

export interface StartupReceipt {
  readonly mode: IngressPolicy["mode"];
  readonly lines: ReadonlyArray<string>;
}

export function buildStartupReceipt(
  input: StartupReceiptInput,
): Result<StartupReceipt, StartupReceiptError> {
  if (input.projectDir.trim().length === 0) {
    return err({ _tag: "MissingProjectDir" });
  }
  if (input.repos.length === 0) {
    return err({ _tag: "MissingRepoList" });
  }

  const lines = [
    `Mode:      ${input.ingress.mode}`,
    `Project:   ${input.projectDir}`,
    ...input.repos.map((repo) => `Repo:      https://github.com/${repo}`),
    `Bridge:    http://localhost:${input.bridgePort}`,
    `Dashboard: http://localhost:${input.dashboardPort}`,
  ];

  if (input.ingress.mode === "github-demo") {
    lines.push(`Gateway:   ${input.gatewayUrl ?? input.ingress.gatewayUrl}`);
    lines.push(`Public:    ${input.publicUrl ?? input.ingress.publicUrl}`);
  } else {
    lines.push("Gateway:   (local-only)");
    lines.push("Public:    (local-only)");
  }

  lines.push(`Logs:      ${input.logsPath}`);
  lines.push(`Publish:   ${input.publishCommand}`);

  return ok({
    mode: input.ingress.mode,
    lines,
  });
}

export function renderStartupReceipt(receipt: StartupReceipt): string {
  return receipt.lines.join("\n");
}
