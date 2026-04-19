// agent-code-guard wiring (issue #117). Published as
// `eslint-plugin-agent-code-guard`; the plugin registers itself under the
// `agent-code-guard/*` rule prefix.
//
// Triage policy: day-one violations are downgraded to `warn` with a written
// reference to a tracking issue. Promote back to `error` and delete the
// override once the category count reaches zero. New rule categories stay at
// their recommended severity (`error`) by default and gate PRs immediately.

import guard from 'eslint-plugin-agent-code-guard';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'v2/**/*.ts', 'gateway/src/**/*.ts', 'bin/**/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    plugins: {
      'agent-code-guard': guard,
    },
    rules: {
      ...guard.configs.recommended.rules,
      // Pre-existing violations tracked for follow-up. See issue links.
      'agent-code-guard/promise-type': 'warn',          // #119 — 62 sites, Effect migration
      'agent-code-guard/async-keyword': 'warn',         // #120 — 55 sites, Effect migration
      'agent-code-guard/bare-catch': 'warn',            // #121 — 9 sites
      'agent-code-guard/no-raw-throw-new-error': 'warn', // #122 — 5 sites
      'agent-code-guard/record-cast': 'warn',           // #123 — 4 sites
    },
  },
];
