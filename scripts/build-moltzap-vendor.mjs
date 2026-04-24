#!/usr/bin/env node
/**
 * scripts/build-moltzap-vendor — build vendor/moltzap/packages/{protocol,
 * client, app-sdk, claude-code-channel}/dist so the `@moltzap/*` file:
 * deps resolve at runtime and `tsc --noEmit` finds the declaration files.
 *
 * Anchor: sbd#200 disposition queue item 1 (postinstall build). Architect
 * rev 4 §6 "Known vendor-build gap". Without this, `package.json "types":
 * "./dist/index.d.ts"` cannot be satisfied and zapbot tsc reports 11+
 * `Cannot find module '@moltzap/*'` errors.
 *
 * Idempotent: skips when every required dist/index.js already exists.
 * Honors ZAPBOT_SKIP_MOLTZAP_BUILD=1 for CI jobs that ship prebuilt
 * artifacts (e.g., release images baked from a separate stage).
 *
 * Implementation: shells out to `pnpm install --frozen-lockfile
 * --ignore-scripts` inside `vendor/moltzap/` followed by `pnpm -r build`
 * across the four required packages in topological order.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const vendorRoot = join(repoRoot, "vendor", "moltzap");

const REQUIRED = [
  "protocol",
  "client",
  "app-sdk",
  "claude-code-channel",
];

function allBuilt() {
  for (const pkg of REQUIRED) {
    const entry = join(vendorRoot, "packages", pkg, "dist", "index.js");
    if (!existsSync(entry)) return false;
  }
  return true;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[build-moltzap-vendor] ${cmd} ${args.join(" ")} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (process.env.ZAPBOT_SKIP_MOLTZAP_BUILD === "1") {
  console.log("[build-moltzap-vendor] skipping (ZAPBOT_SKIP_MOLTZAP_BUILD=1).");
  process.exit(0);
}

if (!existsSync(join(vendorRoot, "package.json"))) {
  console.error(
    "[build-moltzap-vendor] vendor/moltzap is not initialized. Run:\n" +
      "  git submodule update --init vendor/moltzap",
  );
  process.exit(1);
}

if (allBuilt()) {
  console.log("[build-moltzap-vendor] vendor dist already present; skipping.");
  process.exit(0);
}

const pnpmArgs = [
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  "--config.confirmModulesPurge=false",
];
run("pnpm", pnpmArgs, vendorRoot);

const buildFilters = REQUIRED.flatMap((pkg) => ["--filter", `./packages/${pkg}`]);
run("pnpm", [...buildFilters, "-r", "build"], vendorRoot);

if (!allBuilt()) {
  console.error(
    "[build-moltzap-vendor] build completed but expected dist/index.js is still missing.",
  );
  process.exit(1);
}
console.log("[build-moltzap-vendor] vendor dist ready.");
