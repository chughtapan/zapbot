import type {
  InstallationToken,
} from "../types.ts";

export type Iso8601 = string & { readonly __brand: "Iso8601" };

export interface InstallationTokenOk {
  readonly token: InstallationToken;
  readonly expires_at: Iso8601;
}

export type InstallationTokenError =
  | { readonly error: "unauthorized"; readonly message: string }
  | { readonly error: "app_not_configured"; readonly message: string }
  | { readonly error: "internal_error"; readonly message: string };

export type InstallationTokenStatus =
  | { readonly status: 200; readonly body: InstallationTokenOk }
  | { readonly status: 401; readonly body: Extract<InstallationTokenError, { readonly error: "unauthorized" }> }
  | { readonly status: 409; readonly body: Extract<InstallationTokenError, { readonly error: "app_not_configured" }> }
  | { readonly status: 500; readonly body: Extract<InstallationTokenError, { readonly error: "internal_error" }> };

export interface MintedInstallationToken {
  readonly token: string;
  readonly expiresAt: Iso8601;
}

export interface InstallationTokenDeps {
  readonly mintToken: () => Promise<MintedInstallationToken | null>;
  readonly apiKey: string;
}

export function verifyBearer(
  authHeader: string | null,
  expected: string,
): null | Extract<InstallationTokenError, { readonly error: "unauthorized" }> {
  throw new Error("not implemented");
}

export function handleInstallationTokenRequest(
  req: Request,
  deps: InstallationTokenDeps,
): Promise<InstallationTokenStatus> {
  throw new Error("not implemented");
}

export function installationTokenRoute(
  deps: InstallationTokenDeps,
): (req: Request) => Promise<Response> {
  throw new Error("not implemented");
}
