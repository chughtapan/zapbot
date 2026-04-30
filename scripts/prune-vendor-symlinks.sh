#!/usr/bin/env bash
# scripts/prune-vendor-symlinks.sh — remove broken nested pnpm symlinks under
# node_modules/@moltzap/*/node_modules/.
#
# bun install of the vendored `file:./vendor/moltzap/packages/<pkg>` deps
# carries each upstream package's own node_modules/ symlinks pointing at the
# upstream's pnpm store (`../../../node_modules/.pnpm/effect@<v>/...`). zapbot
# uses bun, not pnpm, so there is no `.pnpm/` dir at the project root and
# every nested pointer resolves to ENOENT.
#
# tsc and vitest tolerate this because they walk up the resolution chain
# and find the real `node_modules/effect/` at the top level. bun's runtime
# resolver does NOT walk up the same way: when an orchestrator/bridge
# subprocess imports `effect`, bun finds the broken nested symlink first
# and exits with `ENOENT reading "node_modules/@moltzap/runtimes/node_modules/effect"`.
#
# The fix is to delete every broken symlink under node_modules/@moltzap/.
# After deletion, the resolver walks up cleanly to the project-root copy.
# Runs idempotently; safe to re-run after every `bun install`.
#
# This script is wired as `package.json` postinstall so it runs automatically.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCAN_ROOT="$REPO_ROOT/node_modules/@moltzap"

if [ ! -d "$SCAN_ROOT" ]; then
  # No @moltzap installed yet (running pre-install). Quiet exit.
  exit 0
fi

REMOVED=0
while IFS= read -r link; do
  if [ ! -e "$link" ]; then
    rm "$link"
    REMOVED=$((REMOVED + 1))
  fi
done < <(find "$SCAN_ROOT" -type l 2>/dev/null)

if [ "$REMOVED" -gt 0 ]; then
  echo "[prune-vendor-symlinks] removed $REMOVED broken symlink(s) under node_modules/@moltzap/"
fi
