import guard from 'eslint-plugin-safer-by-default';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    files: ['src/**/*.ts', 'gateway/**/*.ts', 'bin/**/*.ts'],
    languageOptions: { parser: tsparser },
    plugins: { 'safer-by-default': guard },
    rules: { ...guard.configs.recommended.rules },
  },
];
