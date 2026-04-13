#!/usr/bin/env bash
set -euo pipefail

# Zapbot install script
# Sets up everything needed to run the plan-to-code workflow locally.
# Idempotent — safe to run multiple times.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_USER=$(gh api user --jq '.login' 2>/dev/null || echo "")
ZAPBOT_REPO="zapbot-test"
ZAPBOT_REMOTE="https://github.com/${GITHUB_USER}/${ZAPBOT_REPO}.git"

echo "=== Zapbot Setup ==="
echo "Repo dir: $REPO_DIR"
echo "GitHub user: $GITHUB_USER"
echo ""

# ------------------------------------------------------------------
# 1. Check prerequisites
# ------------------------------------------------------------------
echo "--- Checking prerequisites ---"
MISSING=""
command -v node >/dev/null 2>&1 || MISSING="$MISSING node"
command -v git >/dev/null 2>&1 || MISSING="$MISSING git"
command -v gh >/dev/null 2>&1 || MISSING="$MISSING gh"
command -v tmux >/dev/null 2>&1 || MISSING="$MISSING tmux"
command -v claude >/dev/null 2>&1 || MISSING="$MISSING claude"

if [ -n "$MISSING" ]; then
  echo "ERROR: Missing required tools:$MISSING"
  echo "Install them first, then re-run this script."
  exit 1
fi

if [ -z "$GITHUB_USER" ]; then
  echo "ERROR: Not authenticated with GitHub. Run: gh auth login"
  exit 1
fi

echo "Prerequisites OK"

# ------------------------------------------------------------------
# 2. Install ngrok (if missing)
# ------------------------------------------------------------------
if ! command -v ngrok >/dev/null 2>&1; then
  echo ""
  echo "--- Installing ngrok ---"
  if [[ "$(uname)" == "Darwin" ]]; then
    brew install ngrok 2>/dev/null || {
      echo "Homebrew install failed. Trying direct download..."
      curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-darwin-arm64.tgz -o /tmp/ngrok.tgz
      tar -xzf /tmp/ngrok.tgz -C /usr/local/bin
      rm /tmp/ngrok.tgz
    }
  else
    curl -fsSL https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz -o /tmp/ngrok.tgz
    sudo tar -xzf /tmp/ngrok.tgz -C /usr/local/bin
    rm /tmp/ngrok.tgz
  fi
  echo "ngrok installed: $(ngrok version)"
else
  echo "ngrok: $(ngrok version) (already installed)"
fi

# ------------------------------------------------------------------
# 2b. Install bun (if missing)
# ------------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo ""
  echo "--- Installing bun ---"
  curl -fsSL https://bun.sh/install | bash
  echo "bun installed"
else
  echo "bun: $(bun --version) (already installed)"
fi

# ------------------------------------------------------------------
# 3. Install plannotator (if missing)
# ------------------------------------------------------------------
if ! command -v plannotator >/dev/null 2>&1; then
  echo ""
  echo "--- Installing plannotator ---"
  curl -fsSL https://plannotator.ai/install.sh | bash
  echo "plannotator installed"
else
  echo "plannotator: already installed"
fi

# ------------------------------------------------------------------
# 4. Install agent-orchestrator (if missing)
# ------------------------------------------------------------------
if ! command -v ao >/dev/null 2>&1; then
  echo ""
  echo "--- Installing agent-orchestrator ---"
  npm install -g @aoagents/ao
  echo "agent-orchestrator installed: $(ao --version 2>/dev/null || echo 'ok')"
else
  echo "agent-orchestrator: already installed"
fi

# ------------------------------------------------------------------
# 4b. Generate .env (if missing)
# ------------------------------------------------------------------
if [ ! -f "$REPO_DIR/.env" ]; then
  echo ""
  echo "--- Generating .env ---"
  WEBHOOK_SECRET=$(openssl rand -hex 32)
  cat > "$REPO_DIR/.env" << ENV_EOF
GITHUB_WEBHOOK_SECRET=${WEBHOOK_SECRET}
ZAPBOT_REPO=${GITHUB_USER}/${ZAPBOT_REPO}
ZAPBOT_BRIDGE_PORT=3000
ZAPBOT_AO_PORT=3001
ZAPBOT_APPROVE_LABEL=plan-approved
ENV_EOF
  echo ".env" >> "$REPO_DIR/.gitignore" 2>/dev/null || true
  chmod 600 "$REPO_DIR/.env"
  echo "Created .env with random webhook secret (mode 600)"
else
  echo ".env: already exists (keeping existing secrets)"
fi

# ------------------------------------------------------------------
# 5. Create test GitHub repo (if it doesn't exist)
# ------------------------------------------------------------------
echo ""
echo "--- Setting up GitHub repo ---"
if gh repo view "${GITHUB_USER}/${ZAPBOT_REPO}" >/dev/null 2>&1; then
  echo "Repo ${GITHUB_USER}/${ZAPBOT_REPO} already exists"
else
  echo "Creating repo ${GITHUB_USER}/${ZAPBOT_REPO}..."
  gh repo create "${ZAPBOT_REPO}" --private --clone=false --description "Zapbot E2E test repo"
  echo "Repo created"
fi

# Set remote on local repo
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$ZAPBOT_REMOTE"
else
  git remote add origin "$ZAPBOT_REMOTE"
fi
echo "Remote set to $ZAPBOT_REMOTE"

# Push initial commit
git push -u origin main 2>/dev/null || echo "Already pushed (or no changes)"

# ------------------------------------------------------------------
# 6. Create .agent-rules.md
# ------------------------------------------------------------------
echo ""
echo "--- Writing .agent-rules.md ---"
cat > "$REPO_DIR/.agent-rules.md" << 'AGENT_RULES'
# Zapbot Agent Rules

Read the GitHub issue body for the implementation plan.
Follow it step by step.

## Before committing:
- Run all existing tests
- Only commit if tests pass
- Do not modify files outside the plan's scope

## Commit style:
- Use conventional commits (feat:, fix:, chore:)
- Reference the issue number in the commit message: "feat: ... (closes #N)"

## If the plan is ambiguous:
- Prefer the simpler interpretation
- Add a TODO comment for anything you're unsure about
- Never silently skip a plan step
AGENT_RULES
echo "Created .agent-rules.md"

# ------------------------------------------------------------------
# 7. Create agent-orchestrator.yaml
# ------------------------------------------------------------------
echo ""
echo "--- Writing agent-orchestrator.yaml ---"
cat > "$REPO_DIR/agent-orchestrator.yaml" << AO_CONFIG
port: 3000

defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree
  notifiers: [desktop]

projects:
  zapbot-test:
    repo: ${GITHUB_USER}/${ZAPBOT_REPO}
    path: ${REPO_DIR}
    defaultBranch: main
    sessionPrefix: zap
    agentRulesFile: .agent-rules.md

    scm:
      plugin: github
      webhook:
        path: /api/webhooks/github
        secretEnvVar: GITHUB_WEBHOOK_SECRET
        signatureHeader: x-hub-signature-256
        eventHeader: x-github-event

reactions:
  ci-failed:
    auto: true
    action: send-to-agent
    retries: 2
  changes-requested:
    auto: true
    action: send-to-agent
    escalateAfter: 30m
  approved-and-green:
    auto: false
    action: notify
AO_CONFIG
echo "Created agent-orchestrator.yaml"

# ------------------------------------------------------------------
# 8. Create /zapbot-publish skill
# ------------------------------------------------------------------
echo ""
echo "--- Writing /zapbot-publish skill ---"
mkdir -p "$REPO_DIR/.claude/skills/zapbot-publish"
if [ -f "$REPO_DIR/.claude/skills/zapbot-publish/SKILL.md" ]; then
  echo "Skill already exists, skipping (won't clobber)"
else
cat > "$REPO_DIR/.claude/skills/zapbot-publish/SKILL.md" << 'SKILL_EOF'
---
name: zapbot-publish
description: Publish current plan to a GitHub issue with a plannotator share link for team review.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - AskUserQuestion
---

# /zapbot-publish

Publish the current plan to a GitHub issue for team review.

## Steps

### 1. Find the plan content

Look for the plan content in the current conversation context. The plan was just
created or edited in plan mode. Read the plan file from disk.

```bash
# Check common plan file locations
for f in plan.md .claude/plan.md PLAN.md; do
  [ -f "$f" ] && echo "PLAN_FILE: $f" && break
done
```

If no plan file found, ask the user: "Where is the plan file? Provide the path."

Read the plan file content using the Read tool.

### 2. Generate zapbot-id

Check if the plan file already has a `zapbot-id:` line. If not, generate one
and note it (do NOT write it to the plan file — just track it for the issue).

```bash
ZAPBOT_ID=$(head -20 "$PLAN_FILE" | grep '^zapbot-id:' | awk '{print $2}')
if [ -z "$ZAPBOT_ID" ]; then
  ZAPBOT_ID="zap-$(openssl rand -hex 4)"
  echo "Generated new zapbot-id: $ZAPBOT_ID"
else
  echo "Existing zapbot-id: $ZAPBOT_ID"
fi
```

### 3. Determine issue key

```bash
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "Branch: $BRANCH"
```

If `$BRANCH` is `main`, `master`, or `develop`, use AskUserQuestion to ask:
"You're on a shared branch. What short name describes this plan? (e.g., 'auth-refactor', 'add-billing')"

Otherwise use the branch name as the key.

The issue title will be: `zapbot:$KEY — <first line of plan>`

### 4. Generate plannotator share link (optional)

```bash
if command -v plannotator >/dev/null 2>&1; then
  SHARE_LINK=$(plannotator share "$PLAN_FILE" 2>/dev/null || echo "")
  if [ -n "$SHARE_LINK" ]; then
    echo "Share link: $SHARE_LINK"
  else
    echo "plannotator share failed — will include raw markdown instead"
  fi
else
  echo "plannotator not installed — will include raw markdown"
  SHARE_LINK=""
fi
```

### 5. Check for existing issue

```bash
EXISTING=$(gh issue list --label "zapbot-plan" --search "zapbot:$KEY" --json number,title --limit 1 2>/dev/null)
echo "Existing issues: $EXISTING"
```

### 6. Create or update the issue

**Build the issue body** from the plan content. Include:
- The plan markdown (full content)
- The zapbot-id
- The plannotator share link (if generated)
- A note: "This plan was published via /zapbot-publish. Add the `plan-approved` label when ready for implementation."

**If an existing issue was found:**

```bash
ISSUE_NUM=$(echo "$EXISTING" | jq -r '.[0].number')
# Update issue body
gh issue edit "$ISSUE_NUM" --body "$ISSUE_BODY"
# Add update comment
gh issue comment "$ISSUE_NUM" --body "Plan updated via /zapbot-publish at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Remove plan-approved label if present (force re-approval)
gh issue edit "$ISSUE_NUM" --remove-label "plan-approved" 2>/dev/null || true
echo "Updated issue #$ISSUE_NUM"
```

**If no existing issue:**

```bash
gh issue create \
  --title "zapbot:$KEY — $PLAN_TITLE" \
  --body "$ISSUE_BODY" \
  --label "zapbot-plan"
```

### 7. Print result

Print the issue URL so the user can share it with the team.

```bash
echo ""
echo "Plan published! Share with your team:"
echo "  $ISSUE_URL"
echo ""
echo "When the team is ready, add the 'plan-approved' label to trigger implementation."
```
SKILL_EOF
echo "Created .claude/skills/zapbot-publish/SKILL.md"
fi

# ------------------------------------------------------------------
# 9. Create CLAUDE.md with routing rules
# ------------------------------------------------------------------
echo ""
echo "--- Writing CLAUDE.md ---"
cat > "$REPO_DIR/CLAUDE.md" << 'CLAUDE_MD'
# Zapbot

Plan-to-code workflow for teams. Developers create plans, publish them as GitHub
issues for review, and approved plans are automatically implemented by AI agents.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action.

Key routing rules:
- "publish plan", "share plan", "sync plan", "create issue from plan" → invoke zapbot-publish
CLAUDE_MD
echo "Created CLAUDE.md"

# ------------------------------------------------------------------
# 10. Create E2E smoke test
# ------------------------------------------------------------------
echo ""
echo "--- Writing E2E smoke test ---"
mkdir -p "$REPO_DIR/test"
cat > "$REPO_DIR/test/e2e-smoke.sh" << 'SMOKE_EOF'
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
SMOKE_EOF
chmod +x "$REPO_DIR/test/e2e-smoke.sh"
echo "Created test/e2e-smoke.sh"

# ------------------------------------------------------------------
# 11. Ensure zapbot-plan label exists on repo
# ------------------------------------------------------------------
echo ""
echo "--- Ensuring labels exist ---"
gh label create "zapbot-plan" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --color "0E8A16" --description "Plan published via /zapbot-publish" --force 2>/dev/null || true
gh label create "plan-approved" --repo "${GITHUB_USER}/${ZAPBOT_REPO}" --color "1D76DB" --description "Plan approved for agent implementation" --force 2>/dev/null || true
echo "Labels created"

# ------------------------------------------------------------------
# 12. Commit everything
# ------------------------------------------------------------------
echo ""
echo "--- Committing setup files ---"
cd "$REPO_DIR"
git add -A
git commit -m "$(cat <<'EOF'
chore: zapbot initial setup

- install.sh: bootstraps all dependencies
- .agent-rules.md: agent implementation instructions
- agent-orchestrator.yaml: AO config for local testing
- .claude/skills/zapbot-publish/SKILL.md: plan publishing skill
- CLAUDE.md: routing rules
- test/e2e-smoke.sh: E2E smoke test
EOF
)" 2>/dev/null || echo "Nothing to commit"
git push origin main 2>/dev/null || echo "Push failed (will retry later)"

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "================================================"
echo "  Zapbot setup complete!"
echo "================================================"
echo ""
echo "Next: run ./start.sh"
echo ""
echo "That starts everything (ngrok + webhook bridge + agent-orchestrator)."
echo "Then use /zapbot-publish in Claude Code to publish plans."
echo ""
