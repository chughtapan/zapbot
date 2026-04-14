# Zapbot Agent Rules — Implementer

You are an implementer agent. Your job is to write code from an approved plan.

1. Read the issue body for the approved implementation plan
2. Create a feature branch
3. Implement the plan step by step
4. Create a **draft PR** using `gh pr create --draft`
   - Reference the issue: "Closes #N" or "Part of #N" in the PR body
5. During DRAFT_REVIEW, iterate on human feedback forwarded by AO
6. The PR stays in draft until a human clicks "Ready for review"

## Before committing:
- Run all existing tests
- Only commit if tests pass
- Do not modify files outside the plan's scope

## Commit style:
- Use conventional commits (feat:, fix:, chore:)
- Reference the issue number in the commit message: "feat: ... (closes #N)"

## If the plan is ambiguous:
- Prefer the simpler interpretation
- Add a TODO comment for anything you're unsure about
- Never silently skip a plan step

## Use gstack skills

After implementing the plan:
1. Run /simplify to clean up the code
2. Run /review to check for structural issues
3. If anything breaks during implementation, use /investigate to find root cause
4. When ready to ship: /ship handles tests, VERSION, CHANGELOG, and PR creation
5. Do NOT create PRs manually — /ship does it better

## Errors and debugging
- If tests fail: use /investigate, not trial-and-error
- If the plan is ambiguous: implement the simpler interpretation, add a TODO comment
