#!/usr/bin/env bash
# scripts/bootstrap-moltzap — initialise the vendor/moltzap git submodule,
# build upstream packages, and rewrite workspace:* specifiers so bun can
# resolve @moltzap/claude-code-channel without a pnpm workspace.
#
# Replaces the old copy-based bootstrap (sbd#194): package.json references
# @moltzap/claude-code-channel via `file:./vendor/moltzap/packages/claude-code-channel`
# resolved through the git submodule, not a locally-staged copy.
#
# Run once before `bun install` (CI runs this automatically):
#   ./scripts/bootstrap-moltzap.sh
#
# Pre-reqs:
#   git >= 2.13 (submodule support)
#   pnpm on PATH (to build moltzap workspace packages)
#   node on PATH (for package.json rewriting)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBMODULE_DIR="$REPO_ROOT/vendor/moltzap"
PACKAGES_DIR="$SUBMODULE_DIR/packages"

echo "[bootstrap-moltzap] initialising git submodule..."
# Explicit path — moltzap has no nested submodules, so we avoid --recursive.
git -C "$REPO_ROOT" submodule update --init vendor/moltzap

if [ ! -d "$PACKAGES_DIR/claude-code-channel" ]; then
  echo "[bootstrap-moltzap] ERROR: vendor/moltzap/packages/claude-code-channel missing." >&2
  echo "[bootstrap-moltzap] Ensure the submodule is pinned to a SHA that includes the package." >&2
  exit 1
fi

# Build in a subshell to avoid changing CWD for the rest of this script.
# sbd#200: @moltzap/app-sdk joins the build set — the bridge now owns
# MoltZapApp lifecycle and imports it directly. `...` picks up the
# transitive deps (protocol + client) in topological order.
# --prefer-frozen-lockfile (not --frozen-lockfile) so a drifted
# vendor/moltzap/pnpm-lock.yaml does not wedge fresh clones.
if [ ! -f "$PACKAGES_DIR/protocol/dist/index.js" ] \
  || [ ! -f "$PACKAGES_DIR/client/dist/index.js" ] \
  || [ ! -f "$PACKAGES_DIR/claude-code-channel/dist/index.js" ] \
  || [ ! -f "$PACKAGES_DIR/app-sdk/dist/index.js" ]; then
  echo "[bootstrap-moltzap] building @moltzap/* workspace packages..."
  (cd "$SUBMODULE_DIR" \
    && pnpm install --prefer-frozen-lockfile \
    && pnpm --filter "@moltzap/claude-code-channel..." --filter "@moltzap/app-sdk..." build)
else
  echo "[bootstrap-moltzap] dist already present — skipping build."
fi

# Rewrite workspace:* specifiers so bun (which does not understand pnpm
# workspace:* syntax) can resolve transitive @moltzap/* deps via file: paths.
# Also strips devDependencies/scripts from nested packages — bun reads those
# fields and would fail trying to resolve their workspace:* dev deps.
EFFECT_VERSION=$(node -e "process.stdout.write(require('$REPO_ROOT/package.json').dependencies.effect)")
REWRITE_SCRIPT='
  const fs = require("fs");
  const [pkgsDir, effectVer] = process.argv.slice(1);
  const SIBLING = {
    "@moltzap/client":              "file:../client",
    "@moltzap/protocol":            "file:../protocol",
    "@moltzap/claude-code-channel": "file:../claude-code-channel",
    "@moltzap/server-core":         null,  // drop — not needed outside the moltzap monorepo
  };
  const pkgs = fs.readdirSync(pkgsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(`${pkgsDir}/${d.name}/package.json`))
    .map(d => d.name);
  for (const pkg of pkgs) {
    const pkgJson = `${pkgsDir}/${pkg}/package.json`;
    const j = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    let dirty = false;
    // Remove fields bun would try to resolve in nested packages.
    for (const f of ["devDependencies", "scripts"]) {
      if (j[f]) { delete j[f]; dirty = true; }
    }
    for (const field of ["dependencies", "peerDependencies"]) {
      if (!j[field]) continue;
      for (const k of Object.keys(j[field])) {
        const v = j[field][k];
        if (typeof v !== "string" || !v.startsWith("workspace:")) continue;
        dirty = true;
        if (!(k in SIBLING)) {
          throw new Error(`Unknown workspace:* dep "${k}" in ${pkg}/package.json — add it to SIBLING in bootstrap-moltzap.sh`);
        }
        if (SIBLING[k] === null) delete j[field][k];
        else j[field][k] = SIBLING[k];
      }
      // Pin effect to match zapbot top-level so Effect brand types are
      // structurally compatible across the package boundary.
      if (field === "dependencies" && j[field] && j[field].effect) {
        j[field].effect = effectVer;
        dirty = true;
      }
    }
    if (dirty) {
      fs.writeFileSync(pkgJson, JSON.stringify(j, null, 2));
      console.log(`[bootstrap-moltzap] rewrote ${pkg}/package.json`);
    }
  }
'
echo "[bootstrap-moltzap] rewriting workspace:* specifiers..."
node -e "$REWRITE_SCRIPT" "$PACKAGES_DIR" "$EFFECT_VERSION"

echo "[bootstrap-moltzap] done. Next: bun install"
