#!/usr/bin/env bash
set -euo pipefail

# zapbot-publish.sh — Publish a plan file as a GitHub issue.
# The plannotator and bridge callback are removed. This script creates or
# updates a GitHub issue with the plan content; nothing more.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

PLAN_FILE="${1:-}"

if [ -z "$PLAN_FILE" ]; then
  for f in plan.md .claude/plan.md PLAN.md; do
    if [ -f "$REPO_DIR/$f" ]; then
      PLAN_FILE="$REPO_DIR/$f"
      break
    fi
  done
fi

if [ -z "$PLAN_FILE" ] || [ ! -f "$PLAN_FILE" ]; then
  echo "Usage: zapbot-publish.sh [plan-file]"
  echo "No plan file found. Checked: plan.md, .claude/plan.md, PLAN.md"
  exit 1
fi

PLAN_CONTENT=$(cat "$PLAN_FILE")
PLAN_TITLE=$(head -1 "$PLAN_FILE" | sed 's/^#\s*//')

BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
KEY="$BRANCH"

ZAPBOT_ID=$(head -20 "$PLAN_FILE" | grep -o 'zapbot-id:\s*zap-[a-f0-9]*' | awk '{print $2}' || echo "")
if [ -z "$ZAPBOT_ID" ]; then
  ZAPBOT_ID="zap-$(openssl rand -hex 4)"
fi

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
if [ -z "$REPO" ]; then
  echo "ERROR: Cannot detect repo. Run from within a git repo with a GitHub remote."
  exit 1
fi

ISSUE_BODY="<!-- zapbot-id: $ZAPBOT_ID -->

$PLAN_CONTENT

---
_Published via zapbot._"

EXISTING=$(gh issue list --repo "$REPO" --label "zapbot-plan" --search "zapbot:$KEY" --json number,title --limit 1 2>/dev/null || echo "[]")
ISSUE_NUM=$(echo "$EXISTING" | jq -r '.[0].number // empty' 2>/dev/null || echo "")

if [ -n "$ISSUE_NUM" ]; then
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY"
  gh issue comment "$ISSUE_NUM" --repo "$REPO" --body "Plan updated at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Updated issue #$ISSUE_NUM"
  ISSUE_URL="https://github.com/$REPO/issues/$ISSUE_NUM"
else
  ISSUE_URL=$(gh issue create \
    --repo "$REPO" \
    --title "zapbot:$KEY — $PLAN_TITLE" \
    --body "$ISSUE_BODY" \
    --label "zapbot-plan")
  ISSUE_NUM=$(echo "$ISSUE_URL" | grep -o '[0-9]*$' || echo "")
  echo "Created issue #$ISSUE_NUM"
fi

echo ""
echo "Plan published! Share with your team:"
echo "  $ISSUE_URL"
