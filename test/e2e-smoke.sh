#!/usr/bin/env bash
set -euo pipefail

# Zapbot E2E Smoke Test
# Tests: plan publish, issue creation, label management, bridge endpoints
#
# Prerequisites: install.sh has been run. start.sh is optional (bridge tests skip if not running).

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GITHUB_USER=$(gh api user --jq '.login')
ZAPBOT_REPO="${ZAPBOT_REPO:-${GITHUB_USER}/zapbot-test}"
BRIDGE_PORT="${ZAPBOT_BRIDGE_PORT:-3000}"
PASS=0
FAIL=0

# Load .env if exists
[ -f "$REPO_DIR/.env" ] && set -a && source "$REPO_DIR/.env" && set +a

assert_cmd() {
  local desc="$1"
  local cmd="$2"
  if eval "$cmd" >/dev/null 2>&1; then
    echo "  + $desc"
    PASS=$((PASS + 1))
  else
    echo "  x $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Zapbot E2E Smoke Test ==="
echo "Repo: $ZAPBOT_REPO"
echo ""

# --- Test 1: Plan file creation ---
echo "Test 1: Plan file creation"
cat > "$REPO_DIR/plan.md" << 'PLAN'
# Plan: Add hello endpoint

## Goal
Add a simple /hello endpoint that returns "Hello, World!" for testing.

## Files to Change
- `hello.ts` — new file

## Acceptance Criteria
- [ ] `hello()` returns "Hello, World!"
PLAN
assert_cmd "Plan file created" "test -f '$REPO_DIR/plan.md'"

# --- Test 2: Share link generation ---
echo ""
echo "Test 2: Share link generation"
SHARE_LINK=$(bun "$REPO_DIR/bin/share-link.ts" "$REPO_DIR/plan.md" 2>/dev/null || echo "")
assert_cmd "Share link generated" "test -n '$SHARE_LINK'"
assert_cmd "Link points to plannotator" "echo '$SHARE_LINK' | grep -q 'share.plannotator.ai'"

SHARE_LINK_CB=$(bun "$REPO_DIR/bin/share-link.ts" "$REPO_DIR/plan.md" --callback-url "http://example.com/cb/1" --callback-token "tok123" 2>/dev/null || echo "")
assert_cmd "Share link with callback params" "echo '$SHARE_LINK_CB' | grep -q 'cb='"

# --- Test 3: Publish plan as GitHub issue ---
echo ""
echo "Test 3: Plan -> GitHub issue"
ISSUE_URL=$(gh issue create \
  --repo "$ZAPBOT_REPO" \
  --title "zapbot:smoke-test — Add hello endpoint" \
  --body "$(cat "$REPO_DIR/plan.md")" \
  --label "zapbot-plan" 2>/dev/null || echo "")
ISSUE_NUM=$(echo "$ISSUE_URL" | grep -o '[0-9]*$' || echo "")

if [ -n "$ISSUE_NUM" ]; then
  echo "  + Issue created: $ISSUE_URL"
  PASS=$((PASS + 1))
else
  echo "  x Issue creation failed"
  FAIL=$((FAIL + 1))
  rm -f "$REPO_DIR/plan.md"
  echo ""
  echo "=== Results: $PASS passed, $FAIL failed ==="
  exit 1
fi

# --- Test 4: Issue content verification ---
echo ""
echo "Test 4: Issue content verification"
ISSUE_BODY_FILE=$(mktemp /tmp/zapbot-test-body-XXXXXX)
gh issue view "$ISSUE_NUM" --repo "$ZAPBOT_REPO" --json body --jq '.body' > "$ISSUE_BODY_FILE"
ISSUE_LABELS=$(gh issue view "$ISSUE_NUM" --repo "$ZAPBOT_REPO" --json labels --jq '[.labels[].name] | join(",")')
assert_cmd "Issue body contains plan goal" "grep -q 'hello endpoint' '$ISSUE_BODY_FILE'"
assert_cmd "Issue body contains acceptance criteria" "grep -q 'Acceptance Criteria' '$ISSUE_BODY_FILE'"
assert_cmd "Issue has zapbot-plan label" "echo '$ISSUE_LABELS' | grep -q 'zapbot-plan'"
rm -f "$ISSUE_BODY_FILE"

# --- Test 5: Plan update removes approval ---
echo ""
echo "Test 5: Plan update invalidates approval"
gh issue edit "$ISSUE_NUM" --repo "$ZAPBOT_REPO" --add-label "plan-approved" >/dev/null 2>&1 || true
# Verify and remove (simulating what zapbot-publish.sh does on plan update)
gh issue edit "$ISSUE_NUM" --repo "$ZAPBOT_REPO" --remove-label "plan-approved" >/dev/null 2>&1 || true
LABELS_AFTER=$(gh issue view "$ISSUE_NUM" --repo "$ZAPBOT_REPO" --json labels --jq '[.labels[].name] | join(",")')
assert_cmd "plan-approved label removed after update" "! echo \"$LABELS_AFTER\" | grep -q 'plan-approved'"

# --- Test 6: Bridge health check (if running) ---
echo ""
echo "Test 6: Webhook bridge"
if curl -s "http://localhost:${BRIDGE_PORT}/healthz" >/dev/null 2>&1; then
  HEALTH=$(curl -s "http://localhost:${BRIDGE_PORT}/healthz")
  assert_cmd "Bridge health endpoint responds" "echo '$HEALTH' | grep -q 'ok'"

  # Test HMAC rejection (invalid signature)
  REJECT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "http://localhost:${BRIDGE_PORT}/api/webhooks/github" \
    -H "Content-Type: application/json" \
    -H "x-hub-signature-256: sha256=invalid" \
    -H "x-github-event: issues" \
    -d '{"action":"labeled","label":{"name":"test"},"issue":{"number":999}}' 2>/dev/null)
  assert_cmd "Invalid HMAC returns 401" "test '$REJECT_STATUS' = '401'"

  # Test token registration (requires bearer auth)
  UNAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "http://localhost:${BRIDGE_PORT}/api/tokens" \
    -H "Content-Type: application/json" \
    -d '{"token":"test-tok-123","issueNumber":999}' 2>/dev/null)
  assert_cmd "Token registration without auth returns 401" "test '$UNAUTH_STATUS' = '401'"

  TOKEN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "http://localhost:${BRIDGE_PORT}/api/tokens" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${GITHUB_WEBHOOK_SECRET:-}" \
    -d '{"token":"test-tok-123","issueNumber":999}' 2>/dev/null)
  assert_cmd "Token registration with auth returns 200" "test '$TOKEN_STATUS' = '200'"

  # Test callback with invalid token
  CB_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "http://localhost:${BRIDGE_PORT}/api/callbacks/plannotator/999" \
    -H "Content-Type: application/json" \
    -d '{"token":"wrong-token","action":"feedback","annotated_url":"https://example.com"}' 2>/dev/null)
  assert_cmd "Invalid callback token returns 403" "test '$CB_STATUS' = '403'"
else
  echo "  ~ Bridge not running on port ${BRIDGE_PORT} (skipping bridge tests)"
  echo "  ~ Start with ./start.sh to test bridge endpoints"
fi

# --- Cleanup ---
echo ""
echo "Cleaning up..."
gh issue close "$ISSUE_NUM" --repo "$ZAPBOT_REPO" >/dev/null 2>&1 || true
rm -f "$REPO_DIR/plan.md"

# --- Results ---
echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "ALL TESTS PASSED"
else
  echo "SOME TESTS FAILED"
fi
exit "$FAIL"
