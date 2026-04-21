---
name: zap
description: Zapbot plan-to-code workflow. Routes to publish and help.
allowed-tools:
  - Bash
  - Read
  - Write
  - AskUserQuestion
---

## Preamble

```bash
REPO=$(git remote get-url origin 2>/dev/null | sed 's/.*github.com[:/]\(.*\)\.git/\1/' | sed 's/.*github.com[:/]\(.*\)/\1/')
echo "REPO: $REPO"
gh auth status >/dev/null 2>&1 && echo "GH: ok" || echo "GH: missing"
```

# /zapbot

Single entry point for the current zapbot workflow.

## Routing

Parse the user's arguments to determine what they want:

- If args contain "publish" or "share" or "plan" → invoke the `zapbot-publish` skill.
- If args contain "help" or nothing → show the help block below.
- If args contain an issue number → tell the user to comment `@zapbot status` on that issue.
- Teammate-facing status/publish flows should read `~/.zapbot/config.json` and use the top-level `gateway` key.

## Help

Show:
```
Zapbot commands:
  /zapbot publish     Publish a plan to GitHub as a dispatchable issue
  /zapbot help        Show this help

Issue workflow:
  @zapbot plan this         Dispatch a direct ao session
  @zapbot investigate this  Dispatch a direct ao session
  @zapbot status            Ask the bot to summarize issue state via the gateway

Current repo: {REPO}
```
