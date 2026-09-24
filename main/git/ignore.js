import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { snapshot } from './discard.js';
import { loadWorktree } from './worktree.js';
import { IGNORE_FILE, IGNORE_KINDS, appendIgnoreRule, ignoreChoice, validIgnorePath } from './ignore-plan.js';

/** Past this, `.gitignore` is not something to append to blindly. */
const SIZE_LIMIT = 1024 * 1024;

/**
 * Appends the rule for one untracked path to the root `.gitignore`.
 *
 * The renderer names a path and a kind, never a pattern: the path must still
 * be in the Untracked section of a fresh `git status`, and the pattern is
 * computed here from both (see ignore-plan.js). Writing the file is the one
 * step that is not a Git command, so it is journaled in the console like an
 * editor launch — `🌱 Twig append .gitignore <pattern>` — and it is bracketed
 * by two backups under `refs/twig/discard`, which is what Undo restores from.
 *
 * @param {{ cwd: string, log: object, path: string, kind: string }} options
 * @returns {Promise<{ ok: boolean, message?: string, pattern: string, created?: boolean, stillShown?: boolean,
 *   undo?: { before: string, after: string, created: boolean } }>}
 */
export async function addIgnoreRule({ cwd, log, path: file, kind }) {
  if (!IGNORE_KINDS.includes(kind) || !validIgnorePath(file)) throw new TypeError('Invalid ignore request');
  const { pattern } = ignoreChoice(file, kind);
  const tree = await loadWorktree({ cwd, log });
  if (!tree.untracked.some(entry => entry.path === file)) throw new Error(`${file} is not untracked any more. Refresh to see the current state.`);
  // A `.gitignore` Git tracks but that is deleted here would come back as a
  // new file, and Undo could not tell the two apart.
  if ([...tree.staged, ...tree.unstaged].some(entry => entry.path === IGNORE_FILE && entry.status === 'D')) {
    throw new Error(`${IGNORE_FILE} is deleted in the working tree. Restore or commit that first.`);
  }

  const root = await realpath(cwd);
  const target = path.join(root, IGNORE_FILE);
  let created = false;
  let content = '';
  try {
    const info = await lstat(target);
    // Writing through a link could land outside the repository.
    if (!info.isFile()) throw new Error(`${IGNORE_FILE} is not a regular file here; edit it outside 🌱 Twig.`);
    if (info.size > SIZE_LIMIT) throw new Error(`${IGNORE_FILE} is larger than 1 MB; edit it outside 🌱 Twig.`);
    content = await readFile(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    created = true;
  }
  const next = appendIgnoreRule(content, pattern);
  if (!next.added) {
    return { ok: false, pattern, message: `${pattern} is already in ${IGNORE_FILE}, yet ${file} is still shown: a later rule (starting with !) includes it again.` };
  }

  const label = `${pattern} to ${IGNORE_FILE}`;
  const before = await snapshot({ cwd, log, files: [IGNORE_FILE], message: `🌱 Twig backup before adding ${label}` });
  await journaled({ log, cwd, pattern, run: () => writeFile(target, next.content, created ? { mode: 0o644 } : undefined) });
  const after = await snapshot({ cwd, log, files: [IGNORE_FILE], message: `🌱 Twig state after adding ${label}` });
  const fresh = await loadWorktree({ cwd, log });
  return { ok: true, pattern, created, stillShown: fresh.untracked.some(entry => entry.path === file), undo: { before, after, created } };
}

/** One journal entry for the write, shaped like a command so the console can show it. */
async function journaled({ log, cwd, pattern, run }) {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  await log.start({ id, executable: '🌱 Twig', argv: ['append', IGNORE_FILE, pattern], cwd, startedAt, operation: `Add to ${IGNORE_FILE}` });
  try {
    await run();
    await log.output(id, 'stdout', `${pattern}\n`);
    await log.finish(id, { code: 0, stdout: `${pattern}\n`, stderr: '', cancelled: false, ms: Math.round(performance.now() - started), startedAt });
  } catch (error) {
    await log.output(id, 'stderr', `${error.message}\n`);
    await log.finish(id, { code: 1, stdout: '', stderr: error.message, cancelled: false, ms: Math.round(performance.now() - started), startedAt });
    throw new Error(`Could not write ${IGNORE_FILE}. See the command console.`);
  }
}
