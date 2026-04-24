#!/usr/bin/env bash
# scripts/bootstrap-moltzap — stage local `@moltzap/*` packages into vendor/.
#
# Anchors: sbd#170 SPEC rev 2 §5 (dependency on `@moltzap/app-sdk`); operator
# note: "Use `~/moltzap/` local tree (npm out-of-date)" — the app-sdk is not
# yet published. This script copies the latest built packages out of
# `~/moltzap/packages/{app-sdk,client,protocol}`, rewrites their
# `workspace:*` deps to `*`, and drops them into `vendor/moltzap/` so
# `bun install` can resolve them via the `file:` paths declared in
# `package.json`.
#
# Run once before `bun install`:
#   ./scripts/bootstrap-moltzap.sh
#
# Pre-reqs:
#   ~/moltzap checked out and built (`pnpm install && pnpm build`).
#   `node` + `bun` on PATH.

set -euo pipefail

MOLTZAP_ROOT="${MOLTZAP_ROOT:-$HOME/moltzap}"
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/moltzap"

if [ ! -d "$MOLTZAP_ROOT/packages/app-sdk/dist" ]; then
  echo "[bootstrap-moltzap] ERROR: $MOLTZAP_ROOT/packages/app-sdk/dist missing." >&2
  echo "[bootstrap-moltzap] Run: cd $MOLTZAP_ROOT && pnpm install && pnpm build" >&2
  exit 1
fi

mkdir -p "$VENDOR_DIR"
rm -rf "$VENDOR_DIR"/app-sdk "$VENDOR_DIR"/client "$VENDOR_DIR"/protocol

for pkg in app-sdk client protocol; do
  src="$MOLTZAP_ROOT/packages/$pkg"
  dst="$VENDOR_DIR/$pkg"
  cp -r "$src" "$dst"
  rm -rf "$dst/node_modules"
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    // Drop dev-only fields so bun install does not pull in vitest/
    // docs infra for these vendored packages.
    delete j.devDependencies;
    delete j.scripts;
    for (const field of ["dependencies", "peerDependencies"]) {
      if (!j[field]) continue;
      for (const k of Object.keys(j[field])) {
        if (typeof j[field][k] === "string" && j[field][k].startsWith("workspace:")) {
          // Point nested deps at the sibling vendored package so bun
          // does not fall back to the (stale) npm-registry version.
          if (k === "@moltzap/protocol") j[field][k] = "file:../protocol";
          else if (k === "@moltzap/client") j[field][k] = "file:../client";
          else if (k === "@moltzap/server-core") delete j[field][k];
          else j[field][k] = "*";
        }
      }
      // Align effect version with zapbot top-level so TS brand types
      // match across packages (otherwise `Effect<T, E>` from app-sdk
      // is structurally incompatible with the local callers).
      if (field === "dependencies" && j[field].effect) {
        j[field].effect = "3.21.1";
      }
    }
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  ' "$dst/package.json"
  echo "[bootstrap-moltzap] staged @moltzap/$pkg at $dst"
done

echo "[bootstrap-moltzap] done. Next: bun install"
