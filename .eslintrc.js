module.exports = {
  env: {
    browser: true,
    es2021: true,
    webextensions: true,
    node: true,
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: 'script',
  },
  rules: {
    // Security
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'no-new-func': 'error',
    'no-script-url': 'error',

    // Quality
    'no-console': ['warn', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always'],
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    curly: 'error',
    'no-var': 'error',
    'prefer-const': 'error',

    // Style
    semi: ['error', 'always'],
    quotes: ['error', 'single', { avoidEscape: true }],
  },
  overrides: [
    {
      files: ['tests/**/*.js'],
      env: {
        jest: true,
        node: true,
      },
      rules: {
        'no-console': 'off',
      },
    },
    {
      files: ['build.js'],
      env: {
        node: true,
      },
      rules: {
        'no-console': 'off',
      },
    },
  ],
  ignorePatterns: ['lib/', 'dist/', 'node_modules/'],
};
