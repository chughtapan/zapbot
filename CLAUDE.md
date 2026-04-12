# Zapbot

Plan-to-code workflow for teams. Developers create plans, publish them as GitHub
issues for review, and approved plans are automatically implemented by AI agents.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action.

Key routing rules:
- "publish plan", "share plan", "sync plan", "create issue from plan" → invoke zapbot-publish
