#!/usr/bin/env bash
set -euo pipefail

# Publish a plan to a GitHub issue with plannotator share link.
# Usage: zapbot-publish.sh <plan-file> [--key <feature-key>]

REPO="${ZAPBOT_REPO:-}"
BRIDGE_URL="${ZAPBOT_BRIDGE_URL:-}"
APPROVE_LABEL="${ZAPBOT_APPROVE_LABEL:-plan-approved}"

# Load .env from the project directory (not the zapbot tool dir)
PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
[ -f "$PROJECT_ROOT/.env" ] && set -a && source "$PROJECT_ROOT/.env" && set +a

show_help() {
  cat <<HELP
Usage: zapbot-publish.sh <plan-file> [--key <feature-key>]

  Publishes a plan as a GitHub issue with a plannotator share link.

Options:
  --key <name>    Feature key for the issue title (default: git branch name)
  --help          Show this help

Environment:
  ZAPBOT_REPO          GitHub repo (owner/name). Auto-detected if not set.
  ZAPBOT_BRIDGE_URL    Webhook bridge URL for plannotator callbacks (optional)
  ZAPBOT_APPROVE_LABEL Label that triggers implementation (default: plan-approved)
HELP
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
  echo "Run: zapbot-publish.sh --help"
  exit 1
fi

# Auto-detect repo
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
  if [ -z "$REPO" ]; then
    echo "ERROR: Could not detect repo. Set ZAPBOT_REPO or run from a GitHub-connected repo."
    exit 1
  fi
fi

# Check gh auth
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: Not authenticated with GitHub."
  echo "FIX: Run 'gh auth login'"
  exit 1
fi

# Determine key
if [ -z "$KEY" ]; then
  KEY=$(git branch --show-current 2>/dev/null || echo "")
  if [ -z "$KEY" ] || [ "$KEY" = "main" ] || [ "$KEY" = "master" ] || [ "$KEY" = "develop" ]; then
    echo "ERROR: On shared branch '$KEY'. Use --key <feature-name>"
    exit 1
  fi
fi

# Read plan
PLAN_CONTENT=$(cat "$PLAN_FILE")
PLAN_TITLE=$(head -1 "$PLAN_FILE" | sed 's/^#* *//')
CONTENT_HASH=$(echo "$PLAN_CONTENT" | shasum -a 256 | cut -c1-8)
ZAPBOT_ID="zap-${CONTENT_HASH}"

# Check for existing issue
EXISTING=$(gh issue list --repo "$REPO" --label "zapbot-plan" --search "zapbot:${KEY}" --json number --limit 1 2>/dev/null || echo "[]")
ISSUE_NUM=$(echo "$EXISTING" | jq -r '.[0].number // empty' 2>/dev/null || echo "")

# For new issues, create first to get the issue number (needed for callback URL)
if [ -z "$ISSUE_NUM" ] || [ "$ISSUE_NUM" = "null" ]; then
  ISSUE_URL=$(gh issue create --repo "$REPO" \
    --title "zapbot:${KEY} — ${PLAN_TITLE}" \
    --body "_Setting up..._" \
    --label "zapbot-plan")
  ISSUE_NUM=$(echo "$ISSUE_URL" | grep -o '[0-9]*$')
  IS_NEW="true"
else
  IS_NEW="false"
fi

# Generate share link (now that we know the issue number)
SHARE_LINK=""
CB_TOKEN=""
ZAPBOT_DIR="${ZAPBOT_DIR:-$HOME/.claude/skills/zapbot}"

if [ -f "$ZAPBOT_DIR/bin/share-link.ts" ] && command -v bun >/dev/null 2>&1; then
  if [ -n "$BRIDGE_URL" ]; then
    CB_TOKEN=$(openssl rand -hex 16)
    SHARE_LINK=$(bun "$ZAPBOT_DIR/bin/share-link.ts" "$PLAN_FILE" \
      --callback-url "${BRIDGE_URL}/api/callbacks/plannotator/${ISSUE_NUM}" \
      --callback-token "$CB_TOKEN" 2>/dev/null || echo "")
  else
    SHARE_LINK=$(bun "$ZAPBOT_DIR/bin/share-link.ts" "$PLAN_FILE" 2>/dev/null || echo "")
  fi
fi

# Build issue body
ISSUE_BODY="<!-- zapbot-id: ${ZAPBOT_ID} -->"
[ -n "$SHARE_LINK" ] && ISSUE_BODY="${ISSUE_BODY}

**[Review this plan in Plannotator](${SHARE_LINK})**"

ISSUE_BODY="${ISSUE_BODY}

${PLAN_CONTENT}

---
_Published via zapbot. Add the \`${APPROVE_LABEL}\` label when ready for implementation._"

# Single edit to set the final body (and remove approval label if updating)
if [ "$IS_NEW" = "true" ]; then
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY" >/dev/null
  echo "Created issue #${ISSUE_NUM}"
else
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY" --remove-label "$APPROVE_LABEL" 2>/dev/null || \
    gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY" >/dev/null
  gh issue comment "$ISSUE_NUM" --repo "$REPO" --body "Plan updated at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
  echo "Updated issue #${ISSUE_NUM}"
fi

# Register callback token with bridge
if [ -n "$CB_TOKEN" ] && [ -n "$BRIDGE_URL" ]; then
  curl -s -X POST "${BRIDGE_URL}/api/tokens" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${GITHUB_WEBHOOK_SECRET:-}" \
    -d "{\"token\":\"${CB_TOKEN}\",\"issueNumber\":${ISSUE_NUM}}" >/dev/null 2>&1 || \
    echo "WARNING: Could not register callback token with bridge"
fi

ISSUE_URL="https://github.com/${REPO}/issues/${ISSUE_NUM}"
echo ""
echo "Plan published! Share with your team:"
echo "  ${ISSUE_URL}"
echo ""
echo "When ready, add the '${APPROVE_LABEL}' label to trigger implementation."
