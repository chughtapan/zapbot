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

Single entry point for the zapbot plan-to-code workflow.

## Routing

Parse the user's arguments to determine what they want:

- If args contain "publish" or "share" or "plan" → invoke the `zapbot-publish` skill.
- If args contain "help" or nothing → show the help block below.
- If args contain an issue number → tell the user to comment `@zapbot status` on that issue.

## Help

Show:
```
Zapbot commands:
  /zapbot publish     Publish a plan to GitHub as a zapbot-plan issue
  /zapbot help        Show this help

Team workflow (on any issue):
  @zapbot plan this         Dispatch an agent to plan the work
  @zapbot investigate this  Dispatch an investigator
  @zapbot status            Ask the bot to summarize issue state

Current repo: {REPO}
```
