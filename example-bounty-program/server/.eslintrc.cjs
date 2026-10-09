module.exports = {
  root: true,
  env: { node: true, es2022: true, jest: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  ignorePatterns: ['data/', 'tmp/', 'coverage/'],
  overrides: [
    {
      files: ['campaign/**/*.js', 'scripts/campaign-inspect.js'],
      extends: ['eslint:recommended'],
      rules: {
        'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
        'id-length': ['error', { min: 2, properties: 'never' }],
        'max-statements-per-line': ['error', { max: 1 }],
      },
    },
  ],
};
