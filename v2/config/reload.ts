import { type Result } from "../types.ts";
import type {
  BridgeRuntimeConfig,
  ConfigReloadError,
  ReloadedRuntimeConfig,
} from "./types.ts";

export function reloadBridgeRuntimeConfig(
  current: BridgeRuntimeConfig,
  next: BridgeRuntimeConfig,
): Result<ReloadedRuntimeConfig, ConfigReloadError> {
  throw new Error("not implemented");
}
