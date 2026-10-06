import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../git/exec.js';
import { selectPipelines } from './engine.js';
import { evaluateConditions } from '../../renderer/src/features/automations/condition-eval.js';
import {
  LOCK_PATHS, bumpTargets, findStringValue, nextVersions, replaceStringValue, validBumpPath
} from '../../renderer/src/features/automations/version-bump.js';

/** Reads a regular file inside the repository, or null; a symlink is not followed out of it. */
async function readInside(cwd, file) {
  if (!validBumpPath(file) && !/(?:^|\/)package-lock\.json$/.test(file)) return null;
  const full = path.resolve(cwd, file);
  const relative = path.relative(cwd, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) return null;
    return await readFile(full, 'utf8');
  } catch { return null; }
}

/**
 * The "Bump version" automation action. The action only *configures* a bump
 * (which package.json, the default choice); the edit is made by the commit
 * itself — the commit panel's or an agent proposal's — after every check has
 * passed and right before `git commit`, so a refused commit never leaves a
 * bumped file behind. The edit changes only the version string in
 * package.json and, when present, the root package's two entries in
 * package-lock.json; npm never runs.
 * @param {{ log: object, automations: object }} options
 */
export function createBumper({ log, automations }) {
  /**
   * What a commit of `files` would bump: `{ choice, targets: [{ path, current,
   * next, lock }] }`, or null when no enabled pre-commit pipeline has a bump
   * action whose conditions hold for this commit.
   * @param {{ repo: { id: string, path: string }, files: (string | { path: string })[] }} request
   */
  async function plan({ repo, files }) {
    const cwd = repo.path;
    const localConfig = automations.config(repo.id);
    if (localConfig.settings.enabled === false) return null;
    const { pipelines } = await selectPipelines({ event: 'pre-commit', cwd, localConfig, trust: automations.trust(repo.id) });
    const head = await runGit({ cwd, log, argv: ['rev-parse', '--abbrev-ref', 'HEAD'], operation: 'Background: read current branch' });
    const branch = head.code === 0 && head.stdout.trim() !== 'HEAD' ? head.stdout.trim() : null;
    const changedFiles = files.map(file => (typeof file === 'string' ? file : file.path));
    const context = { branch, remote: null, changedFiles, addedLines: [], commitMessage: null };
    const actions = pipelines.filter(pipeline => evaluateConditions(pipeline.conditions, context))
      .flatMap(pipeline => pipeline.actions.filter(action => action.type === 'bumpVersion' && evaluateConditions(action.conditions, context)));
    if (!actions.length) return null;

    const targets = [];
    for (const file of new Set(actions.flatMap(action => bumpTargets(action, changedFiles)))) {
      if (!validBumpPath(file)) continue;
      const text = await readInside(cwd, file);
      const current = text === null ? null : findStringValue(text, ['version'])?.value ?? null;
      const next = current ? nextVersions(current) : null;
      if (!next?.patch) continue;
      const lockPath = path.posix.join(path.posix.dirname(file), 'package-lock.json');
      const lockText = await readInside(cwd, lockPath);
      const lock = lockText !== null && LOCK_PATHS.some(keys => findStringValue(lockText, keys)?.value === current) ? lockPath : null;
      targets.push({ path: file, current, next, lock });
    }
    return targets.length ? { choice: actions[0].default, targets } : null;
  }

  /**
   * Writes the chosen versions and stages exactly those files. Each file is
   * re-read and must still hold the version the plan showed.
   * @returns {Promise<{ path: string, from: string, to: string, files: { file: string, before: string }[] }[]>}
   */
  async function apply({ repo, choice, plan: shown }) {
    if (!shown || !['patch', 'minor', 'major'].includes(choice)) return [];
    const cwd = repo.path;
    const applied = [];
    try {
      for (const target of shown.targets) {
        const to = target.next[choice];
        const before = await readInside(cwd, target.path);
        const after = before === null ? null : replaceStringValue(before, ['version'], target.current, to);
        if (after === null) throw new Error(`${target.path} no longer has version ${target.current}; open the commit again.`);
        const entry = { path: target.path, from: target.current, to, files: [] };
        applied.push(entry);
        await writeFile(path.resolve(cwd, target.path), after, 'utf8');
        entry.files.push({ file: target.path, before });
        if (target.lock) {
          const lockBefore = await readInside(cwd, target.lock);
          let lockAfter = lockBefore;
          for (const keys of LOCK_PATHS) lockAfter = (lockAfter !== null && replaceStringValue(lockAfter, keys, target.current, to)) || lockAfter;
          if (lockAfter !== null && lockAfter !== lockBefore) {
            await writeFile(path.resolve(cwd, target.lock), lockAfter, 'utf8');
            entry.files.push({ file: target.lock, before: lockBefore });
          }
        }
      }
      const paths = applied.flatMap(entry => entry.files.map(item => item.file));
      if (paths.length) {
        const staged = await runGit({ cwd, log, argv: ['add', '--', ...paths.map(file => `:(literal)${file}`)], operation: `Stage the version bump (${paths.join(', ')})` });
        if (staged.code !== 0) throw new Error('Git could not stage the version bump.');
      }
      return applied;
    } catch (error) {
      await revert({ repo, applied });
      throw error;
    }
  }

  /** Puts the files back as they were before `apply`. The caller restores the index. */
  async function revert({ repo, applied }) {
    for (const entry of applied) {
      for (const { file, before } of entry.files) await writeFile(path.resolve(repo.path, file), before, 'utf8');
    }
  }

  return { plan, apply, revert };
}

/**
 * The commit panel's commit with a version bump. The plan is read again from
 * what is staged now; the files are written and staged right before
 * `git commit`, and if the commit fails they and the index go back to what
 * they were. Returns the commit's warnings plus one line per bumped file.
 * @param {{ request: { cwd: string, log: object }, repo: { id: string, path: string }, choice: string,
 *   bumper: ReturnType<typeof createBumper>, commit: (request: object) => Promise<string[]> }} options
 */
export async function commitWithBump({ request, repo, choice, bumper, commit }) {
  const { cwd, log } = request;
  const saved = await runGit({ cwd, log, argv: ['write-tree'], operation: 'Save the index before a version bump' });
  if (saved.code !== 0) throw new Error('The index has entries Git cannot save; resolve them before bumping the version.');
  const staged = await runGit({ cwd, log, argv: ['diff', '--cached', '--name-only', '-z'], operation: 'Background: staged files' });
  const plan = await bumper.plan({ repo, files: staged.stdout.split('\0').filter(Boolean) });
  if (!plan) return commit(request);
  const applied = await bumper.apply({ repo, choice, plan });
  try {
    const warnings = await commit(request);
    return [...warnings, ...applied.map(entry => `Version of ${entry.path}: ${entry.from} → ${entry.to}.`)];
  } catch (error) {
    await bumper.revert({ repo, applied });
    await runGit({ cwd, log, argv: ['read-tree', saved.stdout.trim()], operation: 'Restore the index after a failed commit' });
    throw error;
  }
}
