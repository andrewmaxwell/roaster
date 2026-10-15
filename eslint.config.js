import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {ignores: ['node_modules/', 'ui/vendor/', 'logs/', 'logs-sim/']},
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {...globals.node},
    },
    rules: {
      'dot-notation': 'warn',
      'object-shorthand': 'warn',
      'prefer-const': [
        'warn',
        {destructuring: 'all', ignoreReadBeforeAssign: true},
      ],
      'no-unused-vars': [
        'error',
        {caughtErrors: 'none', ignoreRestSiblings: true},
      ],
    },
  },
  // The browser UI.
  {
    files: ['main.js', 'ui/**/*.js'],
    languageOptions: {globals: {...globals.browser}},
  },
];
