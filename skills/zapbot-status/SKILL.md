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
# Update check (1-hour cache)
GITHUB_RAW=$(cat ~/.zapbot/github-raw-url 2>/dev/null || echo "https://raw.githubusercontent.com/chughtapan/zapbot/main")
CACHE_FILE="$HOME/.zapbot/last-update-check"
MARKER_FILE="$HOME/.zapbot/just-upgraded-from"
LOCAL_VERSION=$(cat ~/.zapbot/skill-version 2>/dev/null || echo "0.0.0")

if [ -f "$MARKER_FILE" ]; then
  _OLD=$(cat "$MARKER_FILE" 2>/dev/null || echo "unknown")
  rm -f "$MARKER_FILE"
  echo "JUST_UPGRADED $_OLD $LOCAL_VERSION"
else
  NOW=$(date +%s)
  LAST=$(cat "$CACHE_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -gt 3600 ]; then
    REMOTE=$(curl -fsSL --max-time 3 "$GITHUB_RAW/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "")
    date +%s > "$CACHE_FILE" 2>/dev/null || true
    if echo "$REMOTE" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+' 2>/dev/null; then
      [ "$LOCAL_VERSION" != "$REMOTE" ] && echo "UPGRADE_AVAILABLE $LOCAL_VERSION $REMOTE" || true
    fi
  fi
fi
```

If output shows `UPGRADE_AVAILABLE <old> <new>`:
  1. Run:
     ```bash
     GITHUB_RAW=$(cat ~/.zapbot/github-raw-url 2>/dev/null || echo "https://raw.githubusercontent.com/chughtapan/zapbot/main")
     curl -fsSL "$GITHUB_RAW/install.sh" | bash
     ```
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
