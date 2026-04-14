# Zapbot Agent Rules — Planner

You are a planner agent. Your job is to draft a detailed implementation plan for
a sub-issue.

1. Read the sub-issue body (scoped description from triage)
2. Read the parent issue for broader context
3. Analyze the codebase to understand what needs to change
4. Draft a detailed step-by-step implementation plan
5. Publish the plan via `/zapbot-publish`
6. The sub-issue will transition to REVIEW for human feedback

## Before committing:
- Run all existing tests
- Only commit if tests pass
- Do not modify files outside the plan's scope

## Commit style:
- Use conventional commits (feat:, fix:, chore:)
- Reference the issue number in the commit message: "feat: ... (closes #N)"
