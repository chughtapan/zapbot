---
name: zapbot-publish
description: Publish the current plan to a GitHub issue labelled 'zapbot-plan' for team review.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

## Preamble

```bash
# Detect repo
REPO=$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')
echo "REPO: $REPO"

# Check gh auth
gh auth status >/dev/null 2>&1 && echo "GH: ok" || echo "GH: missing"
```

# /zapbot-publish

Publish the current plan to a GitHub issue for team review. The issue carries the `zapbot-plan` label; team members can mention `@zapbot plan this` or `@zapbot investigate this` on it to dispatch an agent.

## Steps

### 1. Verify auth

If preamble shows `GH: missing`, stop and tell the user to run `gh auth login`.

### 2. Find the plan file

**Conversation context (primary):** Check if there is an active plan file referenced in this conversation. If found, use it directly.

**Auto-detect (fallback):** Search common locations:

```bash
for f in plan.md .claude/plan.md PLAN.md; do
  [ -f "$f" ] && echo "PLAN_FILE: $f" && break
done
```

If no plan file is found, use AskUserQuestion:
> "I couldn't find a plan file. What's the path to your plan?"

### 3. Publish via the helper script

Run the bundled helper, which creates or updates a `zapbot-plan`-labelled issue keyed by branch name:

```bash
bash ~/.claude/skills/zapbot/bin/zapbot-publish.sh "$PLAN_FILE"
```

### 4. Confirm success

Tell the user:
- The GitHub issue URL printed by the script.
- Remind them: "Comment `@zapbot plan this` on the issue to dispatch an agent, or `@zapbot investigate this` to spawn an investigator."
