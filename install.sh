#!/usr/bin/env bash
set -euo pipefail

# Zapbot skill installer — downloads SKILL.md files for Claude Code teammates.
# No git, no bun, no setup script needed.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/chughtapan/zapbot/main/install.sh | bash
#
# From a fork:
#   ZAPBOT_GITHUB_RAW=https://raw.githubusercontent.com/yourfork/zapbot/main \
#     bash <(curl -fsSL $ZAPBOT_GITHUB_RAW/install.sh)

GITHUB_RAW="${ZAPBOT_GITHUB_RAW:-https://raw.githubusercontent.com/chughtapan/zapbot/main}"
SKILLS_DIR="$HOME/.claude/skills"
STATE_DIR="$HOME/.zapbot"

SKILLS=(
  "zap:skills/zap/SKILL.md"
  "zapbot-publish:skills/zapbot-publish/SKILL.md"
  "zapbot-status:skills/zapbot-status/SKILL.md"
)

echo "=== Zapbot Skill Install ==="
echo ""

mkdir -p "$STATE_DIR"

# Save previous version for upgrade marker
OLD_VERSION=""
[ -f "$STATE_DIR/skill-version" ] && OLD_VERSION=$(cat "$STATE_DIR/skill-version" 2>/dev/null || echo "")

# Fetch remote version
echo "Checking version..."
REMOTE_VERSION=$(curl -fsSL --max-time 5 "$GITHUB_RAW/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "")
if [ -z "$REMOTE_VERSION" ]; then
  echo "ERROR: Could not fetch VERSION from $GITHUB_RAW/VERSION"
  exit 1
fi

# Download each skill
for entry in "${SKILLS[@]}"; do
  SKILL_NAME="${entry%%:*}"
  SKILL_PATH="${entry#*:}"
  mkdir -p "$SKILLS_DIR/$SKILL_NAME"
  echo "  Downloading $SKILL_NAME..."
  if ! curl -fsSL --max-time 10 "$GITHUB_RAW/$SKILL_PATH" -o "$SKILLS_DIR/$SKILL_NAME/SKILL.md"; then
    echo "ERROR: Failed to download $SKILL_NAME"
    exit 1
  fi
done

# Write version and source URL
echo "$REMOTE_VERSION" > "$STATE_DIR/skill-version"
echo "$GITHUB_RAW" > "$STATE_DIR/github-raw-url"

# Set upgrade marker if version changed
if [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$REMOTE_VERSION" ]; then
  echo "$OLD_VERSION" > "$STATE_DIR/just-upgraded-from"
fi

# Install plannotator if missing
if ! command -v plannotator >/dev/null 2>&1; then
  echo "  Installing plannotator..."
  curl -fsSL https://plannotator.ai/install.sh | bash 2>/dev/null || echo "  Warning: plannotator install failed (optional)"
fi

echo ""
echo "================================================"
echo "  Zapbot skills v${REMOTE_VERSION} installed!"
echo "================================================"
echo ""
echo "Run /zap in Claude Code to get started."
echo ""
