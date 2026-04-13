---
name: zapbot-publish
description: Publish current plan to a GitHub issue with a plannotator share link for team review.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

# /zapbot-publish

Publish the current plan to a GitHub issue for team review.

## Steps

### 1. Find the plan file

```bash
PLAN_FILE=""
for f in plan.md .claude/plan.md PLAN.md; do
  [ -f "$f" ] && PLAN_FILE="$f" && echo "Found plan: $f" && break
done
[ -z "$PLAN_FILE" ] && echo "NO_PLAN_FILE"
```

If `NO_PLAN_FILE`, ask the user: "Where is the plan file? Provide the path."

### 2. Determine the feature key

```bash
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
echo "Branch: $BRANCH"
```

If branch is `main`, `master`, or `develop`, use AskUserQuestion:
"You're on a shared branch. What short name describes this plan? (e.g., 'auth-refactor', 'add-billing')"

Use the answer as `KEY`. Otherwise use the branch name.

### 3. Publish

```bash
bash bin/zapbot-publish.sh "$PLAN_FILE" --key "$KEY"
```

The script handles everything: share link generation, issue creation/update,
label invalidation on plan changes, and callback token registration.

### 4. Report result

Tell the user the issue URL and remind them:
"When the team is ready, add the 'plan-approved' label to trigger implementation."
