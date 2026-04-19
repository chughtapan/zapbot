/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    'src/**/*.ts',
    'v2/**/*.ts',
    'gateway/src/**/*.ts',
    'bin/**/*.ts',
    '!**/*.test.ts',
  ],
  testRunner: 'vitest',
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',
  plugins: [
    '@stryker-mutator/vitest-runner',
    '@stryker-mutator/typescript-checker',
  ],
  thresholds: { high: 80, low: 60, break: 0 },
  reporters: ['clear-text', 'html', 'progress'],
  ignoreStatic: true,
  incremental: true,
  incrementalFile: '.stryker-tmp/incremental.json',
  concurrency: 4,
};
