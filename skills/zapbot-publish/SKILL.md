---
name: zapbot-publish
description: Publish current plan to a GitHub issue with a plannotator review link for team review.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

## Preamble

```bash
# Check plannotator
command -v plannotator >/dev/null 2>&1 && echo "PLANNOTATOR: installed" || echo "PLANNOTATOR: missing"

# Check config
[ -f ~/.zapbot/config.json ] && echo "CONFIG: exists" || echo "CONFIG: missing"

# Detect repo
REPO=$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')
echo "REPO: $REPO"

# Ensure state dir exists
mkdir -p ~/.zapbot

# Print raw config for Claude to parse
[ -f ~/.zapbot/config.json ] && cat ~/.zapbot/config.json || echo "{}"

# Check if this is the first publish for this repo
REPO_HASH=$(echo "$REPO" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "$REPO" | tr '/' '-')
[ -f ~/.zapbot/first-publish-done."$REPO_HASH" ] && echo "FIRST_PUBLISH: no" || echo "FIRST_PUBLISH: yes"
```

# /zapbot-publish

Publish the current plan to a GitHub issue for team review. Follow these steps in order, reacting to the preamble output and handling failures gracefully.

## Steps

### 1. Ensure config exists

If preamble shows `CONFIG: missing`, create a skeleton config:

Use the Write tool to create `~/.zapbot/config.json` with contents:
```json
{"bridges":{}}
```

Then re-read the config file so you have it in memory.

If `CONFIG: exists`, read `~/.zapbot/config.json` to load current config.

### 2. Ensure bridge URL is configured for this repo

Parse the config JSON. Look up `bridges[REPO]` where REPO is the value from the preamble.

If `bridges[REPO]` does not exist or has no `url` field, use AskUserQuestion:
> "What's your zapbot bridge URL? (Ask your eng lead if you don't have it.)"

Write the answer into the config under `bridges[REPO].url` using the Write tool to update `~/.zapbot/config.json`.

### 3. Ensure bridge secret is configured for this repo

If `bridges[REPO].secret` is missing or empty, use AskUserQuestion:
> "What's the bridge API secret? (Your eng lead has this.)"

Write the answer into the config under `bridges[REPO].secret` using the Write tool to update `~/.zapbot/config.json`.

### 4. Ensure plannotator is installed

If preamble shows `PLANNOTATOR: missing`, auto-install it:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

If the install fails, warn the user:
> "Plannotator install failed. I can still publish the plan without a review link (degraded mode)."

Continue in degraded mode -- skip the plannotator annotate step later (step 8) but complete all other steps.

### 5. Dry Run

If the user passed `--dry-run` as an argument OR the preamble shows `FIRST_PUBLISH: yes`, perform a dry run before proceeding.

First, check bridge reachability:

```bash
curl -sf $BRIDGE_URL/healthz >/dev/null 2>&1 && echo "reachable" || echo "unreachable"
```

Then show the following preview (filling in values from preamble and config):

```
DRY RUN — config check:
  Repo:     {REPO from preamble}
  Bridge:   {BRIDGE_URL from config} (reachable ✓/✗)
  Labels:   [planning]
  Review:   Plannotator link will be generated
  Callback: Token will be registered at bridge

  Run /zapbot-publish to execute for real.
```

**If triggered by explicit `--dry-run`:** Stop here. Do not proceed to the real publish.

**If triggered by `FIRST_PUBLISH: yes` (not explicit `--dry-run`):** Use AskUserQuestion:
> "This is your first publish. Everything looks configured correctly. Proceed?"
> A) Yes, publish now
> B) Cancel

If the user chooses A, continue with the real publish (step 6 onward). If the user chooses B, stop.

### 6. Find the plan file

**Conversation context (primary):** Check if there is an active plan file referenced in this conversation. If found, use it directly.

**Auto-detect (fallback):** Search common locations:

```bash
for f in plan.md .claude/plan.md PLAN.md; do
  [ -f "$f" ] && echo "PLAN_FILE: $f" && break
done
```

Also check `~/.gstack/projects/` and `~/.claude/plans/` for recently modified .md files:

```bash
find ~/.gstack/projects/ ~/.claude/plans/ -name '*.md' -mmin -1440 -maxdepth 2 2>/dev/null | xargs ls -t 2>/dev/null | head -3
```

If no plan file is found, use AskUserQuestion:
> "I couldn't find a plan file. What's the path to your plan?"

Use the discovered path as `PLAN_FILE`.

### 7. Extract title

Read the plan file and extract the title from the first `# heading` line.

### 8. Generate plannotator review link

Skip this step if plannotator is not installed (degraded mode from step 4).

**Important:** `plannotator annotate` can hang indefinitely. Always wrap it with a timeout.

Run two commands via Bash. First, extract the URL:
```bash
PLANNOTATOR_URL=$(timeout 15 plannotator annotate "$PLAN_FILE" 2>&1 | grep -o 'https://share.plannotator.ai/[^ ]*' | head -1)
echo "URL: $PLANNOTATOR_URL"
```

Then check the result:
- If `PLANNOTATOR_URL` is empty (timeout or no output): warn the user that plannotator failed to produce a link. Continue in degraded mode (no review link in the issue).
- If `PLANNOTATOR_URL` is set: use it in the issue body (step 9).

**Never swallow errors silently.** The user must know if plannotator failed and why.

### 9. Create or update GitHub issue

**IMPORTANT:** Steps 8 and 9 MUST run in a single Bash call so `$PLANNOTATOR_URL` stays in scope. The URL can be 8KB+ — never round-trip it through tool output.

```bash
# Continuing from step 8 in the same Bash call:
gh issue create --title "$TITLE" --body "$(cat <<EOF
...body using ${PLANNOTATOR_URL} via shell substitution...
EOF
)" --label "planning" --repo "$REPO"
```

The body should include:
- The plan content (or a summary with the plannotator annotate link)
- A link to the plannotator annotate URL (if available)
- A note that adding the `plan-approved` label triggers implementation

If an issue for this plan already exists, use `gh issue edit` instead of creating a new one.

Capture the `ISSUE_NUMBER` from the output.

### 10. Register callback token with bridge

Read the bridge URL and secret from the config (loaded in steps 2-3).

```bash
curl -X POST "$BRIDGE_URL/api/tokens" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"token":"'"$TOKEN"'","issueNumber":'"$ISSUE_NUMBER"',"repo":"'"$REPO"'"}'
```

Generate `TOKEN` as a random string (e.g., `uuidgen` or `openssl rand -hex 16`).

### 11. Notify bridge of plan_published

The callback token (generated in step 10) must be included in the request body as `"token"`. Without it the bridge returns 401.

```bash
curl -X POST "$BRIDGE_URL/api/callbacks/plannotator/$ISSUE_NUMBER" \
  -H "Content-Type: application/json" \
  -d '{"event":"plan_published","author":"'"$(git config user.name 2>/dev/null || echo unknown)"'","token":"'"$TOKEN"'"}'
```

### 12. Confirm success

Tell the user:
- The GitHub issue URL
- The plannotator annotate link (if available, otherwise note degraded mode)
- Remind them: "When the team is ready, add the 'plan-approved' label to trigger implementation."

After displaying the success message, mark first publish as done:

```bash
REPO_HASH=$(echo "$REPO" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "$REPO" | tr '/' '-')
touch ~/.zapbot/first-publish-done."$REPO_HASH"
```
