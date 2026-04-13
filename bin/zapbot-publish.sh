#!/usr/bin/env bash
set -euo pipefail

# Publish a plan to a GitHub issue with plannotator share link.
# Usage: zapbot-publish.sh <plan-file> [--key <feature-key>]

REPO="${ZAPBOT_REPO:-}"
BRIDGE_URL="${ZAPBOT_BRIDGE_URL:-}"
APPROVE_LABEL="${ZAPBOT_APPROVE_LABEL:-plan-approved}"

show_help() {
  echo "Usage: zapbot-publish.sh <plan-file> [--key <feature-key>]"
  echo ""
  echo "  Publishes a plan as a GitHub issue with a plannotator share link."
  echo ""
  echo "Options:"
  echo "  --key <name>    Feature key for the issue title (default: git branch name)"
  echo "  --help          Show this help"
  echo ""
  echo "Environment:"
  echo "  ZAPBOT_REPO          GitHub repo (owner/name). Auto-detected from gh if not set."
  echo "  ZAPBOT_BRIDGE_URL    Webhook bridge URL for plannotator callbacks (optional)"
  echo "  ZAPBOT_APPROVE_LABEL Label that triggers implementation (default: plan-approved)"
  exit 0
}

# Parse args
PLAN_FILE=""
KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help) show_help ;;
    --key) shift; KEY="${1:-}" ;;
    *) [ -z "$PLAN_FILE" ] && PLAN_FILE="$1" ;;
  esac
  shift
done

if [ -z "$PLAN_FILE" ] || [ ! -f "$PLAN_FILE" ]; then
  echo "ERROR: Plan file not found: ${PLAN_FILE:-<none>}"
  echo "Usage: zapbot-publish.sh <plan-file> [--key <feature-key>]"
  exit 1
fi

# Auto-detect repo
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
  if [ -z "$REPO" ]; then
    echo "ERROR: Could not detect repo. Set ZAPBOT_REPO or run from inside a git repo with gh configured."
    exit 1
  fi
fi

# Check gh auth
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: Not authenticated with GitHub."
  echo "FIX: Run 'gh auth login' or 'gh auth refresh -s repo'"
  exit 1
fi

# Determine key
if [ -z "$KEY" ]; then
  KEY=$(git branch --show-current 2>/dev/null || echo "")
  if [ -z "$KEY" ] || [ "$KEY" = "main" ] || [ "$KEY" = "master" ] || [ "$KEY" = "develop" ]; then
    echo "ERROR: On shared branch '$KEY'. Use --key <feature-name> to specify a feature key."
    exit 1
  fi
fi

# Read plan
PLAN_CONTENT=$(cat "$PLAN_FILE")
PLAN_TITLE=$(head -1 "$PLAN_FILE" | sed 's/^#* *//')

# Generate zapbot-id (content-based hash for stability)
CONTENT_HASH=$(echo "$PLAN_CONTENT" | shasum -a 256 | cut -c1-8)
ZAPBOT_ID="zap-${CONTENT_HASH}"

# Generate share link
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SHARE_LINK=""
CB_TOKEN=""

if [ -f "$REPO_ROOT/bin/share-link.ts" ] && command -v bun >/dev/null 2>&1; then
  if [ -n "$BRIDGE_URL" ]; then
    # Generate callback token and register with bridge
    CB_TOKEN=$(openssl rand -hex 16)
    SHARE_LINK=$(bun "$REPO_ROOT/bin/share-link.ts" "$PLAN_FILE" \
      --callback-url "${BRIDGE_URL}/api/callbacks/plannotator/ISSUE_NUM_PLACEHOLDER" \
      --callback-token "$CB_TOKEN" 2>/dev/null || echo "")
  else
    SHARE_LINK=$(bun "$REPO_ROOT/bin/share-link.ts" "$PLAN_FILE" 2>/dev/null || echo "")
  fi
fi

# Build issue body
ISSUE_BODY="<!-- zapbot-id: ${ZAPBOT_ID} -->"
if [ -n "$SHARE_LINK" ]; then
  ISSUE_BODY="${ISSUE_BODY}

**[Review this plan in Plannotator](${SHARE_LINK})**"
fi
ISSUE_BODY="${ISSUE_BODY}

${PLAN_CONTENT}

---
_Published via zapbot. Add the \`${APPROVE_LABEL}\` label when ready for implementation._"

# Check for existing issue
EXISTING=$(gh issue list --repo "$REPO" --label "zapbot-plan" --search "zapbot:${KEY}" --json number --limit 1 2>/dev/null || echo "[]")
ISSUE_NUM=$(echo "$EXISTING" | jq -r '.[0].number // empty' 2>/dev/null || echo "")

if [ -n "$ISSUE_NUM" ] && [ "$ISSUE_NUM" != "null" ]; then
  # Update existing issue
  # Fix callback URL with real issue number
  if [ -n "$SHARE_LINK" ]; then
    ISSUE_BODY=$(echo "$ISSUE_BODY" | sed "s|ISSUE_NUM_PLACEHOLDER|${ISSUE_NUM}|g")
  fi
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY" >/dev/null
  gh issue comment "$ISSUE_NUM" --repo "$REPO" --body "Plan updated at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
  # Remove approval label (force re-approval after plan change)
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --remove-label "$APPROVE_LABEL" 2>/dev/null || true
  ISSUE_URL="https://github.com/${REPO}/issues/${ISSUE_NUM}"
  echo "Updated issue #${ISSUE_NUM}: ${ISSUE_URL}"
else
  # Create new issue (use temp body, then fix callback URL)
  ISSUE_URL=$(gh issue create --repo "$REPO" \
    --title "zapbot:${KEY} — ${PLAN_TITLE}" \
    --body "placeholder" \
    --label "zapbot-plan" 2>/dev/null)
  ISSUE_NUM=$(echo "$ISSUE_URL" | grep -o '[0-9]*$')

  # Fix callback URL with real issue number
  ISSUE_BODY=$(echo "$ISSUE_BODY" | sed "s|ISSUE_NUM_PLACEHOLDER|${ISSUE_NUM}|g")
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY" >/dev/null

  echo "Created issue #${ISSUE_NUM}: ${ISSUE_URL}"
fi

# Register callback token with bridge (if configured)
if [ -n "$CB_TOKEN" ] && [ -n "$BRIDGE_URL" ]; then
  # Fix the share link callback URL now that we know the issue number
  if [ -n "$SHARE_LINK" ]; then
    SHARE_LINK=$(echo "$SHARE_LINK" | sed "s/ISSUE_NUM_PLACEHOLDER/${ISSUE_NUM}/g")
    # Re-update issue body with correct callback URL
    ISSUE_BODY=$(echo "$ISSUE_BODY" | sed "s|ISSUE_NUM_PLACEHOLDER|${ISSUE_NUM}|g")
    gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY" >/dev/null 2>&1 || true
  fi

  curl -s -X POST "${BRIDGE_URL}/api/tokens" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"${CB_TOKEN}\",\"issueNumber\":${ISSUE_NUM}}" >/dev/null 2>&1 || \
    echo "WARNING: Could not register callback token with bridge at ${BRIDGE_URL}"
fi

echo ""
echo "Plan published! Share with your team:"
echo "  ${ISSUE_URL}"
echo ""
echo "When ready, add the '${APPROVE_LABEL}' label to trigger implementation."
