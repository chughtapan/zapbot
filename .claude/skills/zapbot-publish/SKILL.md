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
