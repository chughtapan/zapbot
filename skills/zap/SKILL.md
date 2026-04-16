---
name: zap
description: Zapbot plan-to-code workflow. Routes to publish, status, and help. Onboards new teammates automatically.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

## Preamble

```bash
# Ensure state dir exists
mkdir -p ~/.zapbot

# Check if configured
[ -f ~/.zapbot/config.json ] && echo "CONFIG: exists" || echo "CONFIG: missing"

# Detect repo
REPO=$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')
echo "REPO: $REPO"

# Print raw config
[ -f ~/.zapbot/config.json ] && cat ~/.zapbot/config.json || echo "{}"

# Check plannotator
command -v plannotator >/dev/null 2>&1 && echo "PLANNOTATOR: installed" || echo "PLANNOTATOR: missing"

# Check for updates (1-hour cache)
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

# /zapbot

Single entry point for the zapbot plan-to-code workflow.

## Upgrade check

If preamble shows `UPGRADE_AVAILABLE X Y`, tell the user:
"Zapbot Y is available (you have X). Update now?"
If yes, run:
```bash
GITHUB_RAW=$(cat ~/.zapbot/github-raw-url 2>/dev/null || echo "https://raw.githubusercontent.com/chughtapan/zapbot/main")
curl -fsSL "$GITHUB_RAW/install.sh" | bash
```
Then tell the user: "Upgraded! Re-run your command to use the new version."

If preamble shows `JUST_UPGRADED X Y`, tell the user:
"Running zapbot vY (just updated from vX)!" and continue.

## Routing

Parse the user's arguments to determine what they want:

- If args contain "publish" or "share" or "plan" -> Read and follow the instructions in `skills/zapbot-publish/SKILL.md` (invoke the Skill tool with skill "zapbot-publish" if available, or read the file and follow its steps)
- If args contain "status" or a number (issue number) -> Read and follow the instructions in `skills/zapbot-status/SKILL.md`
- If args contain "help" -> Show available commands and current config
- If no args -> Check config and either run onboarding wizard or show status overview

## Onboarding Wizard (first-time setup)

If CONFIG is missing OR the current REPO has no bridge entry in config:

1. Welcome the user: "Welcome to Zapbot! Let's get you set up. I need your bridge URL and secret -- your eng lead has these."

2. Use AskUserQuestion: "Do you have a config snippet from your eng lead? It looks like: {\"bridges\":{\"owner/repo\":{\"url\":\"...\",\"secret\":\"...\"}}}"
   - A) Yes, I have it -- paste it
   - B) No, I'll enter URL and secret separately
   - C) I don't know what this is

3. If A: User pastes JSON. If ~/.zapbot/config.json already exists, Read it first, deep-merge the new bridge entries into the existing `bridges` object (preserving other repos), then Write the merged result. If the file does not exist, write the pasted JSON directly.

4. If B: Use AskUserQuestion to ask for bridge URL, then secret. Write to config.json.

5. If C: Explain: "Zapbot needs to talk to your team's bridge server. Ask your eng lead for the bridge URL and secret. They can generate a config snippet by running: zapbot-team-init"

6. After config is saved, validate by hitting the bridge healthz endpoint:
   `curl -sf $BRIDGE_URL/healthz && echo "OK" || echo "FAIL"`
   If output contains "OK", say "Bridge connected! You're ready to go."
   If output contains "FAIL", say "Couldn't reach the bridge at $BRIDGE_URL. Check the URL or ask your eng lead."

7. If PLANNOTATOR is missing, install it:
   `curl -fsSL https://plannotator.ai/install.sh | bash`

8. Show a summary of available commands:
   - /zapbot publish -- publish a plan to GitHub
   - /zapbot status <issue> -- check workflow status
   - /zapbot help -- show this help

## Help

Show:
```
Zapbot commands:
  /zapbot publish     Publish a plan to GitHub with review link
  /zapbot status N    Check workflow status for issue #N
  /zapbot help        Show this help

Current config:
  Repo:    {REPO}
  Bridge:  {bridge URL from config or "not configured"}
  Plannotator: {installed/missing}
```

## Status Overview (when configured, no args)

If the user just types `/zapbot` with no args and config exists:
- Show the help text above
- Mention: "Run /zapbot publish to publish a plan, or /zapbot status <issue> to check a workflow."
