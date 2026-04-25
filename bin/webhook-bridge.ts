/**
 * bin/webhook-bridge — entrypoint shim.
 *
 * Architect rev 4 §2 collapse target: ≤30 LOC of glue. Heavy lifting
 * (config load, SIGHUP reload, post-boot reachability probe, signal
 * handlers, lifecycle ordering) lives in `src/bridge.ts::runBridgeProcess`.
 * This file is just env handoff + a top-level fatal catch.
 *
 * Shared secrets (apiKey, webhookSecret) load via the canonical config
 * path `~/.zapbot/config.json`; port and ingress knobs read directly
 * from `process.env`. See `runBridgeProcess` for the full sequencer.
 */

import { runBridgeProcess } from "../src/bridge.ts";

process.on("unhandledRejection", (err) => {
  console.error(
    "[bridge] Unhandled rejection (non-fatal):",
    err instanceof Error ? err.message : err,
  );
});

runBridgeProcess(process.env).catch((err) => {
  console.error(`[bridge] Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
