/**
 * Starting points for pipelines. Each template returns a fully-formed,
 * editable pipeline (fresh ids every call) — never an opaque preset the user
 * cannot see into. Pure and import-free beyond sibling modules and i18n.
 * Titles and summaries are marked and shown with t(); the names a template
 * gives its pipeline and actions are written in the interface language when
 * the person picks it — they are the person's to edit from then on.
 */
import { makeId, normalizePipeline } from './schema.js';
import { mark, t } from '../../i18n/i18n.js';

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
    id: 'bump-version',
    title: mark('Bump version'),
    summary: mark('Raise the package.json version with every commit — patch by default, chosen when you commit.'),
    build: () => pipeline('pre-commit', t('Bump version'), [
      { type: 'bumpVersion', name: t('Bump package.json'), target: 'file', path: 'package.json', default: 'patch' }
    ])
  },
  {
    id: 'js-ts',
    title: mark('JavaScript / TypeScript'),
    summary: mark('Lint, format check, type-check and test before every commit.'),
    build: () => pipeline('pre-commit', t('JS / TS checks'), [
      { type: 'command', name: 'ESLint', command: 'npm run lint' },
      { type: 'command', name: t('Prettier check'), command: 'npx prettier --check .' },
      { type: 'command', name: 'TypeScript', command: 'npm run typecheck' },
      { type: 'command', name: t('Unit tests'), command: 'npm test' }
    ])
  },
  {
    id: 'conventional-commits',
    title: mark('Conventional Commits'),
    summary: mark('Require the commit subject to follow the Conventional Commits format.'),
    build: () => pipeline('commit-msg', t('Conventional Commits'), [
      { type: 'validateMessage', name: t('Message format'), rule: { mode: 'conventional' } }
    ])
  },
  {
    id: 'protect-main',
    title: mark('Protect main'),
    summary: mark('Block commits made directly on the main branch.'),
    build: () => pipeline('pre-commit', t('Protect main'), [
      { type: 'checkBranch', name: t('No direct commits'), block: ['main', 'master'] }
    ])
  },
  {
    id: 'before-push',
    title: mark('Before push'),
    summary: mark('Run the test suite and a build before pushing.'),
    build: () => pipeline('pre-push', t('Pre-push checks'), [
      { type: 'command', name: t('Tests'), command: 'npm test' },
      { type: 'command', name: t('Build'), command: 'npm run build' }
    ])
  },
  {
    id: 'secret-guard',
    title: mark('Secret guard'),
    summary: mark('Scan the staged changes for credentials and tokens before committing.'),
    build: () => pipeline('pre-commit', t('Secret guard'), [
      { type: 'secretScan', name: t('Scan staged changes') }
    ])
  }
];

export function buildTemplate(id) {
  return TEMPLATES.find(template => template.id === id)?.build() || null;
}
