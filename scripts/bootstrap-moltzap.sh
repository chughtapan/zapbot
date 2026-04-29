#!/usr/bin/env bash
# scripts/bootstrap-moltzap — initialise the vendor/moltzap git submodule,
# build upstream packages, and rewrite workspace:* specifiers so bun can
# resolve @moltzap/claude-code-channel without a pnpm workspace.
#
# Replaces the old copy-based bootstrap (sbd#194): package.json references
# @moltzap/claude-code-channel via `file:./vendor/moltzap/packages/claude-code-channel`
# resolved through the git submodule, not a locally-staged copy.
#
# Usage:
#   ./scripts/bootstrap-moltzap.sh [TARGET_ROOT]
#
# TARGET_ROOT defaults to the current working directory. The doctor
# (bin/zapbot-doctor.ts) passes a workspace path explicitly so the same
# script can provision the main checkout, an orchestrator worktree, or a
# worker worktree.
#
# Idempotency: the script writes a stamp file at
# `TARGET_ROOT/vendor/moltzap/.bootstrap-stamp` containing the submodule SHA
# and effect version. Subsequent runs that match the stamp skip the heavy
# work (submodule init + dist build + manifest rewrites + symlink prune)
# and only re-verify integrity. This makes the postinstall hook safe to
# run on every `bun install` and the doctor safe to invoke on every
# session spawn.
#
# Pre-reqs:
#   git >= 2.13 (submodule support)
#   pnpm on PATH (to build moltzap workspace packages)
#   node on PATH (for package.json rewriting)

set -euo pipefail

TARGET_ROOT="${1:-$PWD}"
TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MAIN_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SUBMODULE_DIR="$TARGET_ROOT/vendor/moltzap"
PACKAGES_DIR="$SUBMODULE_DIR/packages"
# Stamp lives outside the submodule so bootstrap is idempotent without
# adding untracked state to vendor/moltzap. Co-located with workspace.
STAMP_FILE="$TARGET_ROOT/.zapbot-bootstrap-stamp"

# Stamp = "<submodule-sha>:<effect-version>". When stamp matches, the
# heavy bootstrap is a no-op. Effect version is read from the workspace's
# package.json; if a workspace's effect dep changes, we re-pin the rewrites.
EFFECT_VERSION="$(node -e "process.stdout.write(require('$TARGET_ROOT/package.json').dependencies.effect || '')")"

# Submodule SHA from the workspace's gitlink. Worktrees share .git/modules
# with main, so this is consistent across worktrees of the same repo.
SUBMODULE_SHA="$(git -C "$TARGET_ROOT" ls-tree HEAD vendor/moltzap 2>/dev/null | awk '{print $3}' || true)"
EXPECTED_STAMP="${SUBMODULE_SHA}:${EFFECT_VERSION}"

if [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE" 2>/dev/null || true)" = "$EXPECTED_STAMP" ]; then
  echo "[bootstrap-moltzap] stamp matches ($EXPECTED_STAMP); skipping."
  exit 0
fi

echo "[bootstrap-moltzap] target: $TARGET_ROOT"
echo "[bootstrap-moltzap] initialising git submodule..."
# Explicit path — moltzap has no nested submodules, so we avoid --recursive.
git -C "$TARGET_ROOT" submodule update --init vendor/moltzap

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
  # The rewrite step below strips `scripts` and `devDependencies` from
  # vendored package.json files (so bun does not try to resolve their
  # workspace:* dev deps). Restoring from git before pnpm runs lets a
  # subsequent rebuild (e.g., dist deleted) succeed; without this,
  # pnpm reports "None of the selected packages has a build script".
  echo "[bootstrap-moltzap] restoring vendored package.json files for build..."
  git -C "$SUBMODULE_DIR" checkout HEAD -- packages/
  echo "[bootstrap-moltzap] building @moltzap/* workspace packages..."
  (cd "$SUBMODULE_DIR" \
    && pnpm install --prefer-frozen-lockfile \
    && pnpm --filter "@moltzap/claude-code-channel..." --filter "@moltzap/app-sdk..." build)
else
  echo "[bootstrap-moltzap] dist already present — skipping build."
fi

# pnpm install leaves node_modules under each package containing .pnpm-style
# symlinks (e.g. node_modules/effect → ../../../node_modules/.pnpm/effect@.../...).
# When zapbot's bun install resolves these packages via file: deps, those
# nested symlinks get carried into node_modules/@moltzap/<pkg>/node_modules/
# but the .pnpm/ store doesn't follow — so they dangle and the bridge crashes
# at startup with ENOENT. The dist/ artifacts are self-contained; the nested
# node_modules/ is leftover build scaffolding. Strip it unconditionally.
echo "[bootstrap-moltzap] pruning per-package node_modules from vendored packages..."
for pkg_dir in "$PACKAGES_DIR"/*/; do
  rm -rf "${pkg_dir}node_modules"
done

# Rewrite workspace:* specifiers so bun (which does not understand pnpm
# workspace:* syntax) can resolve transitive @moltzap/* deps via file: paths.
# Also strips devDependencies/scripts from nested packages — bun reads those
# fields and would fail trying to resolve their workspace:* dev deps.
REWRITE_SCRIPT='
  const fs = require("fs");
  const [pkgsDir, effectVer] = process.argv.slice(1);
  const SIBLING = {
    "@moltzap/client":      "file:../client",
    "@moltzap/protocol":    "file:../protocol",
    "@moltzap/server-core": null,  // drop — not needed outside the moltzap monorepo
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

# Write stamp last so we only skip on success.
echo "$EXPECTED_STAMP" > "$STAMP_FILE"
echo "[bootstrap-moltzap] done. stamp: $EXPECTED_STAMP. Next: bun install"
