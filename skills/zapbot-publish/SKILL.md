---
name: zapbot-publish
description: Publish current plan to a GitHub issue with a plannotator share link for team review.
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---

## Preamble

```bash
_UPD=$(~/.claude/skills/zapbot/bin/zapbot-update-check 2>/dev/null || true)
[ -n "$_UPD" ] && echo "$_UPD" || true
```

If output shows `UPGRADE_AVAILABLE <old> <new>`:
  1. Run: `cd ~/.claude/skills/zapbot && git pull origin main && ./setup`
  2. Tell user: "Zapbot upgraded v{old} → v{new}."
  3. Continue with the skill.

If output shows `JUST_UPGRADED <old> <new>`:
  Tell user: "Running zapbot v{new} (just updated!)" and continue.

# /zapbot-publish

Publish the current plan to a GitHub issue for team review.

## Steps

### 1. Find the plan file

**Conversation context (primary):** Check if there is an active plan file in this conversation. The host agent's system messages include plan file paths when in plan mode. If found, use it directly.

**Content-based search (fallback):** If no plan file is referenced in conversation context, search by content:

```bash
setopt +o nomatch 2>/dev/null || true  # zsh compat
BRANCH=$(git branch --show-current 2>/dev/null | tr '/' '-')
REPO=$(basename "$(git rev-parse --show-toplevel 2>/dev/null)")
_PLAN_SLUG=$(git remote get-url origin 2>/dev/null | sed 's|.*[:/]\([^/]*/[^/]*\)\.git$|\1|;s|.*[:/]\([^/]*/[^/]*\)$|\1|' | tr '/' '-' | tr -cd 'a-zA-Z0-9._-') || true
_PLAN_SLUG="${_PLAN_SLUG:-$(basename "$PWD" | tr -cd 'a-zA-Z0-9._-')}"
PLAN=""
for PLAN_DIR in "$HOME/.gstack/projects/$_PLAN_SLUG" "$HOME/.claude/plans" "$HOME/.codex/plans" ".gstack/plans"; do
  [ -d "$PLAN_DIR" ] || continue
  PLAN=$(ls -t "$PLAN_DIR"/*.md 2>/dev/null | xargs grep -l "$BRANCH" 2>/dev/null | head -1)
  [ -z "$PLAN" ] && PLAN=$(ls -t "$PLAN_DIR"/*.md 2>/dev/null | xargs grep -l "$REPO" 2>/dev/null | head -1)
  [ -z "$PLAN" ] && PLAN=$(find "$PLAN_DIR" -name '*.md' -mmin -1440 -maxdepth 1 2>/dev/null | xargs ls -t 2>/dev/null | head -1)
  [ -n "$PLAN" ] && break
done
# Legacy fallback: check CWD
if [ -z "$PLAN" ]; then
  for f in plan.md .claude/plan.md PLAN.md; do
    [ -f "$f" ] && PLAN="$f" && break
  done
fi
[ -n "$PLAN" ] && echo "PLAN_FILE: $PLAN" || echo "NO_PLAN_FILE"
```

**Validation:** If a plan file was found via content-based search (not conversation context), read the first 20 lines and verify it is relevant to the current branch's work. If unrelated, treat as "no plan file found."

Use the discovered path as `PLAN_FILE`. If `NO_PLAN_FILE`, ask the user: "Where is the plan file? Provide the path."

### 2. Determine the feature key

Use the `BRANCH` value from step 1. If branch is `main`, `master`, or `develop`, use AskUserQuestion:
"You're on a shared branch. What short name describes this plan? (e.g., 'auth-refactor', 'add-billing')"

Use the answer as `KEY`. Otherwise use the branch name.

### 3. Publish

```bash
bash ~/.claude/skills/zapbot/bin/zapbot-publish.sh "$PLAN_FILE" --key "$KEY"
```

### 4. Report result

Tell the user the issue URL and remind them:
"When the team is ready, add the 'plan-approved' label to trigger implementation."
