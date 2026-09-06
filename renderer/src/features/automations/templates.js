/**
 * Starting points for pipelines. Each template returns a fully-formed,
 * editable pipeline (fresh ids every call) — never an opaque preset the user
 * cannot see into. Pure and import-free beyond sibling modules.
 */
import { makeId, normalizePipeline } from './schema.js';

function pipeline(event, name, actions, extra = {}) {
  return normalizePipeline({
    id: makeId('pipeline'), event, name, enabled: true, source: 'local',
    onFailure: extra.onFailure || 'block',
    conditions: extra.conditions || [],
    actions: actions.map(action => ({ id: makeId('action'), ...action }))
  });
}

export const TEMPLATES = [
  {
    id: 'js-ts',
    title: 'JavaScript / TypeScript',
    summary: 'Lint, format check, type-check and test before every commit.',
    build: () => pipeline('pre-commit', 'JS / TS checks', [
      { type: 'command', name: 'ESLint', command: 'npm run lint' },
      { type: 'command', name: 'Prettier check', command: 'npx prettier --check .' },
      { type: 'command', name: 'TypeScript', command: 'npm run typecheck' },
      { type: 'command', name: 'Unit tests', command: 'npm test' }
    ])
  },
  {
    id: 'conventional-commits',
    title: 'Conventional Commits',
    summary: 'Require the commit subject to follow the Conventional Commits format.',
    build: () => pipeline('commit-msg', 'Conventional Commits', [
      { type: 'validateMessage', name: 'Message format', rule: { mode: 'conventional' } }
    ])
  },
  {
    id: 'protect-main',
    title: 'Protect main',
    summary: 'Block commits made directly on the main branch.',
    build: () => pipeline('pre-commit', 'Protect main', [
      { type: 'checkBranch', name: 'No direct commits', block: ['main', 'master'] }
    ])
  },
  {
    id: 'before-push',
    title: 'Before push',
    summary: 'Run the test suite and a build before pushing.',
    build: () => pipeline('pre-push', 'Pre-push checks', [
      { type: 'command', name: 'Tests', command: 'npm test' },
      { type: 'command', name: 'Build', command: 'npm run build' }
    ])
  },
  {
    id: 'secret-guard',
    title: 'Secret guard',
    summary: 'Scan the staged changes for credentials and tokens before committing.',
    build: () => pipeline('pre-commit', 'Secret guard', [
      { type: 'secretScan', name: 'Scan staged changes' }
    ])
  }
];

export function buildTemplate(id) {
  return TEMPLATES.find(template => template.id === id)?.build() || null;
}
