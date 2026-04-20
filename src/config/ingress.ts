import type { Result } from "../types.ts";
import { err, ok } from "../types.ts";

export type IngressMode = "local-only" | "github-demo";

export type IngressResolutionError =
  | { readonly _tag: "InvalidIngressMode"; readonly mode: string }
  | { readonly _tag: "MissingPublicBridgeUrl" }
  | { readonly _tag: "UnreachablePublicBridgeUrl"; readonly publicUrl: string }
  | { readonly _tag: "DemoModeRequiresGateway"; readonly gatewayUrl: string };

export type IngressPolicy =
  | {
      readonly _tag: "LocalOnly";
      readonly mode: "local-only";
      readonly gatewayUrl: null;
      readonly publicUrl: null;
      readonly requiresReachablePublicUrl: false;
    }
  | {
      readonly _tag: "GitHubDemo";
      readonly mode: "github-demo";
      readonly gatewayUrl: string;
      readonly publicUrl: string;
      readonly requiresReachablePublicUrl: true;
    };

export interface IngressPolicyInputs {
  readonly mode: IngressMode;
  readonly gatewayUrl: string;
  readonly publicUrl: string | null;
  readonly isPublicUrlReachable: (publicUrl: string) => Promise<boolean>;
}

export function resolveIngressPolicy(
  inputs: IngressPolicyInputs,
): Promise<Result<IngressPolicy, IngressResolutionError>> {
  if (inputs.mode === "local-only") {
    return Promise.resolve(
      ok({
        _tag: "LocalOnly",
        mode: "local-only",
        gatewayUrl: null,
        publicUrl: null,
        requiresReachablePublicUrl: false,
      }),
    );
  }

  const gatewayUrl = inputs.gatewayUrl.trim();
  if (gatewayUrl.length === 0) {
    return Promise.resolve(err({ _tag: "DemoModeRequiresGateway", gatewayUrl: inputs.gatewayUrl }));
  }

  const publicUrl = inputs.publicUrl?.trim() ?? null;
  if (publicUrl === null || publicUrl.length === 0) {
    return Promise.resolve(err({ _tag: "MissingPublicBridgeUrl" }));
  }

  return inputs.isPublicUrlReachable(publicUrl).then((reachable) => {
    if (!reachable) {
      return err({ _tag: "UnreachablePublicBridgeUrl", publicUrl });
    }

    return ok({
      _tag: "GitHubDemo",
      mode: "github-demo",
      gatewayUrl,
      publicUrl,
      requiresReachablePublicUrl: true,
    });
  });
}
