import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import hooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'release/**', 'artifacts/**', 'node_modules/**'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node } },
  {
    files: ['renderer/public/*.js', 'scripts/smoke.mjs', 'scripts/history-smoke.mjs', 'scripts/worktree-smoke.mjs', 'scripts/ops-smoke.mjs', 'scripts/browse-smoke.mjs', 'scripts/profile-smoke.mjs', 'scripts/repositories-smoke.mjs', 'scripts/ssh-undo-smoke.mjs'],
    languageOptions: { globals: globals.browser }
  },
  {
    files: ['renderer/src/**/*.{js,jsx}'],
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { react, 'react-hooks': hooks },
    settings: { react: { version: '18.3' } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...hooks.configs.recommended.rules,
      'react/prop-types': 'off'
    }
  }
];
