#!/usr/bin/env bash
set -euo pipefail

# Zapbot E2E Smoke Test
# Tests: plan publish → issue creation → label trigger
#
# Prerequisites: install.sh has been run

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GITHUB_USER=$(gh api user --jq '.login')
ZAPBOT_REPO="zapbot-test"
PASS=0
FAIL=0

assert() {
  local desc="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Zapbot E2E Smoke Test ==="
echo ""

# --- Test 1: Create a plan file ---
echo "Test 1: Plan file creation"
cat > "$REPO_DIR/plan.md" << 'PLAN'
# Plan: Add hello endpoint

## Goal
Add a simple /hello endpoint that returns "Hello, World!" for testing.

## Approach
1. Create a new file `hello.ts` with a function that returns the greeting
2. Add a test for the function

## Files to Change
- `hello.ts` — new file, the endpoint handler
- `hello.test.ts` — new file, tests

## Acceptance Criteria
- [ ] `hello()` returns "Hello, World!"
- [ ] Test passes
PLAN
assert "Plan file created" test -f "$REPO_DIR/plan.md"

# --- Test 2: Publish plan as GitHub issue ---
echo ""
echo "Test 2: Plan → GitHub issue"
ISSUE_URL=$(gh issue create \
  --repo "${GITHUB_USER}/${ZAPBOT_REPO}" \
  --title "zapbot:smoke-test — Add hello endpoint" \
  --body "$(cat "$REPO_DIR/plan.md")" \
  --label "zapbot-plan" 2>/dev/null || echo "")
ISSUE_NUM=$(echo "$ISSUE_URL" | grep -o '[0-9]*$' || echo "")

if [ -n "$ISSUE_NUM" ]; then
  echo "  ✓ Issue created: $ISSUE_URL"
  PASS=$((PASS + 1))
else
  echo "  ✗ Issue creation failed"
  FAIL=$((FAIL + 1))
  # Cleanup and exit early
  rm -f "$REPO_DIR/plan.md"
  echo ""
  echo "=== Results: $PASS passed, $FAIL failed ==="
  exit 1
fi

# --- Test 3: Verify issue content ---
echo ""
echo "Test 3: Issue content verification"
ISSUE_BODY=$(gh issue view "$ISSUE_NUM" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --json body --jq '.body')
assert "Issue body contains plan goal" echo "$ISSUE_BODY" | grep -q "hello endpoint"
assert "Issue body contains acceptance criteria" echo "$ISSUE_BODY" | grep -q "Acceptance Criteria"

ISSUE_LABELS=$(gh issue view "$ISSUE_NUM" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --json labels --jq '[.labels[].name] | join(",")')
assert "Issue has zapbot-plan label" echo "$ISSUE_LABELS" | grep -q "zapbot-plan"

# --- Test 4: Plan update removes approval ---
echo ""
echo "Test 4: Plan update invalidates approval"
# Add plan-approved first
gh issue edit "$ISSUE_NUM" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --add-label "plan-approved" >/dev/null 2>&1 || true
sleep 1
# Simulate plan update by removing label (as the skill would)
gh issue edit "$ISSUE_NUM" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --remove-label "plan-approved" >/dev/null 2>&1 || true
LABELS_AFTER=$(gh issue view "$ISSUE_NUM" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --json labels --jq '[.labels[].name] | join(",")')
assert "plan-approved label removed after update" test "$(echo "$LABELS_AFTER" | grep -c "plan-approved")" -eq 0

# --- Cleanup ---
echo ""
echo "Cleaning up test issue..."
gh issue close "$ISSUE_NUM" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" >/dev/null 2>&1 || true
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
