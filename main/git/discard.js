import { randomUUID } from 'node:crypto';
import { lstat, readlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './exec.js';
import { buildPatch } from './patch-builder.js';
import { loadWorktree, loadWorktreeDiff } from './worktree.js';
import { DISCARD_REF, discardCommand, validDiscardPath } from './discard-plan.js';

/**
 * Discarding changes — the one everyday action that destroys work — made
 * recoverable. Before anything is thrown away, the affected files are written
 * into Git's object store as a commit under the hidden ref DISCARD_REF (its
 * own chain, never shown in the graph: history reads `--exclude=refs/twig/*`).
 * After the discard, the same paths are recorded again. Undo restores from the
 * first commit and Redo from the second, and even once the Undo chain has
 * ended, the content is still in `git log refs/twig/discard`.
 *
 * Nothing here trusts a path list from the renderer to decide *what* is
 * discarded: sections are read from a fresh `git status`, and a single path
 * must be in the section it was discarded from right now.
 */

const IDENTITY = {
  GIT_AUTHOR_NAME: '🌱 Twig', GIT_AUTHOR_EMAIL: 'twig@localhost',
  GIT_COMMITTER_NAME: '🌱 Twig', GIT_COMMITTER_EMAIL: 'twig@localhost'
};
/** Past this many backups the chain starts over; older ones become unreachable and Git may prune them. */
const CHAIN_LIMIT = 200;

async function git({ cwd, log, argv, operation, stdin = null, env = null }) {
  const result = await runGit({ cwd, log, argv, operation, stdin, env });
  if (result.code !== 0) throw new Error(`${operation} failed. See the command console.`);
  return result.stdout;
}

/** Expands untracked folder entries (`dir/`) into the files under them. */
async function expand({ cwd, log, entries }) {
  const files = [];
  for (const entry of entries) {
    if (!entry.endsWith('/')) { files.push(entry); continue; }
    const out = await git({ cwd, log, argv: ['ls-files', '--others', '--exclude-standard', '-z', '--', `:(literal)${entry}`],
      operation: 'Background: list untracked files to back up' });
    files.push(...out.split('\0').filter(Boolean));
  }
  for (const file of files) if (!validDiscardPath(file)) throw new Error(`🌱 Twig cannot back up ${JSON.stringify(file)} safely, so it was not discarded.`);
  return files;
}

/**
 * Records the working-tree copies of `files` as one commit on DISCARD_REF and
 * returns its id. Files that do not exist are simply not in it. Exported for
 * the other edit 🌱 Twig makes to a working-tree file — a rule added to
 * `.gitignore` — which is undone from the same kind of backup.
 */
export async function snapshot({ cwd, log, files, message }) {
  const root = await realpath(cwd);
  const regular = [];
  const records = [];
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid file path');
    let info;
    try { info = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isSymbolicLink()) {
      const oid = (await git({ cwd, log, argv: ['hash-object', '-w', '--stdin'], stdin: await readlink(absolute),
        operation: 'Background: back up a link before discarding' })).trim();
      records.push(`120000 ${oid}\t${file}`);
    } else if (info.isFile()) {
      regular.push({ file, mode: info.mode & 0o111 ? '100755' : '100644' });
    } else {
      throw new Error(`${file} is not a regular file; discard it outside 🌱 Twig.`);
    }
  }
  if (regular.length) {
    // `--stdin-paths` takes plain paths, one per line — no pathspec magic —
    // and `-w` stores each blob, filtered exactly as `git add` would.
    const oids = (await git({ cwd, log, argv: ['hash-object', '-w', '--stdin-paths'], stdin: `${regular.map(item => item.file).join('\n')}\n`,
      operation: `Background: back up ${regular.length} file${regular.length === 1 ? '' : 's'} before discarding` })).trim().split('\n');
    if (oids.length !== regular.length) throw new Error('Could not back up the files; nothing was discarded.');
    regular.forEach((item, index) => records.push(`${item.mode} ${oids[index]}\t${item.file}`));
  }
  // A throwaway index builds the tree, so the real index is never touched.
  const index = path.join(os.tmpdir(), `twig-discard-${randomUUID()}.index`);
  try {
    const env = { GIT_INDEX_FILE: index };
    if (records.length) {
      await git({ cwd, log, argv: ['update-index', '--add', '-z', '--index-info'], stdin: `${records.join('\0')}\0`, env,
        operation: 'Background: build discard backup' });
    }
    const tree = (await git({ cwd, log, argv: ['write-tree'], env, operation: 'Background: build discard backup' })).trim();
    const parent = await runGit({ cwd, log, argv: ['rev-parse', '--verify', '--quiet', `${DISCARD_REF}^{commit}`], operation: 'Background: read discard backups' });
    let parents = [];
    if (parent.code === 0) {
      const count = Number((await git({ cwd, log, argv: ['rev-list', '--count', DISCARD_REF], operation: 'Background: read discard backups' })).trim());
      if (count < CHAIN_LIMIT) parents = ['-p', parent.stdout.trim()];
    }
    const commit = (await git({ cwd, log, argv: ['commit-tree', '--no-gpg-sign', tree, ...parents, '-F', '-'], stdin: message, env: IDENTITY,
      operation: 'Background: record discard backup' })).trim();
    await git({ cwd, log, argv: ['update-ref', '-m', message.split('\n')[0], DISCARD_REF, commit], operation: 'Background: record discard backup' });
    return commit;
  } finally { await rm(index, { force: true }).catch(() => {}); }
}

function refuseConflicts(entries) {
  const conflicts = entries.filter(entry => entry.status === 'U');
  if (conflicts.length) throw new Error(`Resolve ${conflicts.length === 1 ? 'the conflict' : `${conflicts.length} conflicts`} first: discarding would throw away the conflict itself.`);
}
function refuseSpecial(entry) {
  if (entry.submodule) throw new Error(`${entry.path} is a submodule; update it from inside the submodule.`);
  // `git add -N` records a path with no content; restoring the "index version"
  // of it would mean an empty file, which is not what discard promises.
  if (entry.status === 'A') throw new Error(`${entry.path} is only marked for tracking. Unstage it first, then delete it from Untracked.`);
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * The shared shape of every discard: back up, run, record the result.
 * @returns {Promise<{ count: number, undo: { before: string, after: string, paths: string[], removed: string[] } }>}
 */
async function discardWith({ cwd, log, files, removed, label, run }) {
  const before = await snapshot({ cwd, log, files, message: `🌱 Twig backup before discarding ${label}\n\n${files.join('\n')}` });
  await run();
  const after = await snapshot({ cwd, log, files, message: `🌱 Twig state after discarding ${label}\n\n${files.join('\n')}` });
  return { count: files.length, backup: before, undo: { before, after, paths: files, removed } };
}

/**
 * One file from the Changes or Untracked section.
 * @param {{ cwd: string, log: object, path: string, section: 'unstaged' | 'untracked' }} options
 */
export async function discardFile({ cwd, log, path: file, section }) {
  if (!['unstaged', 'untracked'].includes(section)) throw new TypeError('Invalid discard section');
  if (!validDiscardPath(file)) throw new TypeError('Invalid file path');
  const tree = await loadWorktree({ cwd, log });
  const entry = tree[section].find(item => item.path === file);
  if (!entry) throw new Error(`${file} has nothing to discard any more. Refresh to see the current state.`);
  refuseConflicts([entry]);
  refuseSpecial(entry);
  if (section === 'untracked') {
    const files = await expand({ cwd, log, entries: [file] });
    return discardWith({ cwd, log, files, removed: files, label: file,
      run: () => git({ cwd, log, argv: discardCommand('untracked', [file]), operation: `Delete untracked ${file}` }) });
  }
  return discardWith({ cwd, log, files: [file], removed: [], label: file,
    run: () => git({ cwd, log, argv: discardCommand('file', [file]), operation: `Discard changes to ${file}` }) });
}

/**
 * A whole section: every unstaged change, or every untracked path.
 * @param {{ cwd: string, log: object, scope: 'tracked' | 'untracked' }} options
 */
export async function discardAll({ cwd, log, scope }) {
  if (!['tracked', 'untracked'].includes(scope)) throw new TypeError('Invalid discard scope');
  const tree = await loadWorktree({ cwd, log });
  refuseConflicts(tree.unstaged);
  if (scope === 'untracked') {
    const entries = tree.untracked.map(entry => entry.path);
    if (!entries.length) return { count: 0 };
    const files = await expand({ cwd, log, entries });
    return discardWith({ cwd, log, files, removed: files, label: plural(entries.length, 'untracked path'),
      run: async () => {
        for (let at = 0; at < entries.length; at += 200) {
          await git({ cwd, log, argv: discardCommand('untracked-all', entries.slice(at, at + 200)), operation: 'Delete untracked files' });
        }
      } });
  }
  tree.unstaged.forEach(refuseSpecial);
  const files = tree.unstaged.map(entry => entry.path);
  if (!files.length) return { count: 0 };
  return discardWith({ cwd, log, files, removed: [], label: plural(files.length, 'file'),
    run: () => git({ cwd, log, argv: discardCommand('tracked'), stdin: `${files.map(file => `:(literal)${file}`).join('\0')}\0`,
      operation: `Discard changes to ${plural(files.length, 'file')}` }) });
}

/**
 * Selected lines of one file's unstaged diff. The diff is re-read here and
 * compared with the digest the renderer saw, exactly as line staging does:
 * a selection made on a diff that has since changed is refused.
 * @param {{ cwd: string, log: object, path: string, digest: string, selection: object[] }} options
 */
export async function discardSelection({ cwd, log, path: file, digest, selection }) {
  if (!validDiscardPath(file)) throw new TypeError('Invalid file path');
  const current = await loadWorktreeDiff({ cwd, log, path: file, staged: false });
  if (current.digest !== digest) throw new Error('This file changed since the diff was read. Refresh and select again.');
  if (current.added || current.deleted) throw new Error('Lines of a new or deleted file cannot be discarded one by one. Discard the whole file instead.');
  // The unstaged diff's new side *is* the working tree, so it is reverse-applied
  // there — the same mirrored build unstaging uses against the index.
  const patch = buildPatch({ path: file, hunks: current.hunks, selection, reverse: true, mode: current.mode });
  if (patch === null) return { count: 0 };
  const lines = selection.reduce((total, entry) => total + (entry.lines === 'all' ? current.hunks[entry.index]?.lines.length || 0 : entry.lines.length), 0);
  return discardWith({ cwd, log, files: [file], removed: [], label: `${plural(lines, 'selected line')} of ${file}`,
    run: () => git({ cwd, log, argv: discardCommand('lines'), stdin: patch, operation: `Discard selected lines of ${file}` }) });
}
