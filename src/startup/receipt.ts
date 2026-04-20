import type { Result } from "../types.ts";
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
  throw new Error("not implemented");
}

export function renderStartupReceipt(receipt: StartupReceipt): string {
  throw new Error("not implemented");
}
