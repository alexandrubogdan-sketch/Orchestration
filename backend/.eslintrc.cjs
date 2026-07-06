/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
    'prettier',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist', 'node_modules', 'coverage', 'vitest.config.ts'],
  rules: {
    // Non-negotiable: no floats in money paths. Enforced case-by-case in
    // domain/money.ts tests; this rule blocks the most common accidental
    // footgun of comparing floats directly.
    'no-restricted-syntax': [
      'error',
      {
        selector: "BinaryExpression[operator='*'] > Literal[raw=/^\\d+\\.\\d+$/]",
        message: 'Money math must use integer minor units. See src/domain/money.ts.',
      },
    ],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
  },
  overrides: [
    {
      files: ['test/**/*.ts', 'scripts/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
      },
    },
  ],
};
