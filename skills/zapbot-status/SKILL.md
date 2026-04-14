---
name: zapbot-status
description: Check the status of a zapbot workflow for a given GitHub issue.
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
  2. Tell user: "Zapbot upgraded v{old} -> v{new}."
  3. Continue with the skill.

If output shows `JUST_UPGRADED <old> <new>`:
  Tell user: "Running zapbot v{new} (just updated!)" and continue.

```bash
# Detect config and current repo
CONFIG="$HOME/.zapbot/config.json"
if [ ! -f "$CONFIG" ]; then
  echo "NO_CONFIG"
else
  REPO=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]\(.*\)\.git$|\1|;s|.*github.com[:/]\(.*\)$|\1|' || true)
  echo "CONFIG_FILE: $CONFIG"
  echo "REPO: $REPO"
  cat "$CONFIG"
fi
```

If `NO_CONFIG`: tell the user "No zapbot config found at ~/.zapbot/config.json. Run the zapbot setup first."

# /zapbot-status

Check the status of a zapbot workflow for a given GitHub issue.

## Steps

### 1. Read config and extract bridge connection details

Read `~/.zapbot/config.json`. Find the entry matching the current repo (from the preamble `REPO` value). Extract:
- `bridgeUrl` — the bridge base URL
- `secret` — the API key for authentication

If the current repo is not found in the config, ask the user which repo to use.

### 2. Get the issue number

If the user already provided an issue number, use it. Otherwise, ask:
"Which issue number do you want to check?"

### 3. Query the bridge API

```bash
curl -s -H "Authorization: Bearer $SECRET" "$BRIDGE_URL/api/workflows/$ISSUE_NUMBER?repo=$REPO"
```

Replace `$SECRET`, `$BRIDGE_URL`, `$ISSUE_NUMBER`, and `$REPO` with the actual values.

### 4. Present the results

Parse the JSON response and present it in a readable format:

- **Workflow state**: the current state (e.g., TRIAGE, PLANNING, REVIEW, IMPLEMENTING, etc.)
- **Level**: parent or sub
- **Issue number**: the GitHub issue number
- **Draft review cycles**: how many times the PR has been sent back for revision

If the workflow is a parent, also show:
- **Sub-issues**: list each sub-workflow with its issue number, state, and level

If there are agents:
- **Agents**: list each agent with its ID, role, status, and last heartbeat

If the response is a 404 error, tell the user: "No workflow found for issue #N. The issue may not have a zapbot workflow yet."

If the response is an authentication error, tell the user to check their config secret.
