#!/usr/bin/env bash
set -euo pipefail

# zapbot-publish.sh — Publish a plan to a GitHub issue and notify the state machine.
# This is the CLI companion to the /zapbot-publish skill.
# After creating/updating the issue, it emits a plan_published event to the bridge.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Load zapbot env for secrets
[ -f "$HOME/.zapbot/.env" ] && set -a && source "$HOME/.zapbot/.env" && set +a
[ -f ".env" ] && set -a && source ".env" && set +a
# Resolve bridge URL: agent-orchestrator.yaml > env var > default
BRIDGE_URL=""
if [ -f "agent-orchestrator.yaml" ]; then
  BRIDGE_URL=$(grep '^bridge_url:' agent-orchestrator.yaml | awk '{print $2}' || echo "")
fi
if [ -z "$BRIDGE_URL" ]; then
  BRIDGE_URL="${ZAPBOT_BRIDGE_URL:-http://localhost:3000}"
fi
# API key for authenticated bridge endpoints
API_KEY="${ZAPBOT_API_KEY:-}"
PLAN_FILE="${1:-}"

if [ -z "$PLAN_FILE" ]; then
  # Auto-detect plan file
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

# Read plan content
PLAN_CONTENT=$(cat "$PLAN_FILE")
PLAN_TITLE=$(head -1 "$PLAN_FILE" | sed 's/^#\s*//')

# Determine branch/key
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
KEY="$BRANCH"

# Generate zapbot-id
ZAPBOT_ID=$(head -20 "$PLAN_FILE" | grep -o 'zapbot-id:\s*zap-[a-f0-9]*' | awk '{print $2}' || echo "")
if [ -z "$ZAPBOT_ID" ]; then
  ZAPBOT_ID="zap-$(openssl rand -hex 4)"
fi

# Detect repo
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || echo "")
if [ -z "$REPO" ]; then
  echo "ERROR: Cannot detect repo. Run from within a git repo with a GitHub remote."
  exit 1
fi

# Generate plannotator annotate link
SHARE_LINK=""
if command -v plannotator >/dev/null 2>&1; then
  SHARE_LINK=$(plannotator annotate "$PLAN_FILE" 2>/dev/null || echo "")
fi

# Build issue body
ISSUE_BODY="<!-- zapbot-id: $ZAPBOT_ID -->"
if [ -n "$SHARE_LINK" ]; then
  ISSUE_BODY="$ISSUE_BODY
**[Review this plan in Plannotator]($SHARE_LINK)**
"
fi
ISSUE_BODY="$ISSUE_BODY

$PLAN_CONTENT

---
_Published via zapbot. Add the \`plan-approved\` label when ready for implementation._"

# Check for existing issue
EXISTING=$(gh issue list --repo "$REPO" --label "zapbot-plan" --search "zapbot:$KEY" --json number,title --limit 1 2>/dev/null || echo "[]")
ISSUE_NUM=$(echo "$EXISTING" | jq -r '.[0].number // empty' 2>/dev/null || echo "")

if [ -n "$ISSUE_NUM" ]; then
  # Update existing issue
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --body "$ISSUE_BODY"
  gh issue comment "$ISSUE_NUM" --repo "$REPO" --body "Plan updated via zapbot-publish at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  gh issue edit "$ISSUE_NUM" --repo "$REPO" --remove-label "plan-approved" 2>/dev/null || true
  echo "Updated issue #$ISSUE_NUM"
  ISSUE_URL="https://github.com/$REPO/issues/$ISSUE_NUM"
else
  # Create new issue
  ISSUE_URL=$(gh issue create \
    --repo "$REPO" \
    --title "zapbot:$KEY — $PLAN_TITLE" \
    --body "$ISSUE_BODY" \
    --label "zapbot-plan")
  ISSUE_NUM=$(echo "$ISSUE_URL" | grep -o '[0-9]*$' || echo "")
  echo "Created issue #$ISSUE_NUM"
fi

# Register callback token with repo context for plannotator
CB_TOKEN=$(openssl rand -hex 16)
if [ -n "$ISSUE_NUM" ]; then
  curl -s -X POST "${BRIDGE_URL}/api/tokens" \
    -H "Content-Type: application/json" \
    ${API_KEY:+-H "Authorization: Bearer ${API_KEY}"} \
    -d "{\"token\":\"${CB_TOKEN}\",\"issueNumber\":${ISSUE_NUM},\"repo\":\"${REPO}\"}" \
    >/dev/null 2>&1 || true
fi

# Notify the bridge about the plan publication
if [ -n "$ISSUE_NUM" ]; then
  curl -s -X POST "$BRIDGE_URL/api/callbacks/plannotator/$ISSUE_NUM" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"${CB_TOKEN}\",\"repo\":\"${REPO}\",\"event\":\"plan_published\"}" \
    >/dev/null 2>&1 || true
fi

echo ""
echo "Plan published! Share with your team:"
echo "  $ISSUE_URL"
echo ""
echo "When the team is ready, add the 'plan-approved' label to trigger implementation."
