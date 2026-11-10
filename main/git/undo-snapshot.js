import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { limited } from './limited.js';
import { parseStatusV2 } from './status-parser.js';
import { loadOperationState } from './operation-state.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

/**
 * What Undo compares before it reverses anything. Three levels, from the
 * cheapest: `captureRefs` (where HEAD and the local refs are), `stampFiles` and
 * `digestFiles` (a few named paths), `captureState` (everything).
 *
 * The working tree is fingerprinted by metadata, never read: mode, size, inode,
 * and modification and change times to the nanosecond. Only the kernel sets the
 * change time, so any write moves it, even one that keeps the size and puts the
 * mtime back. Reading every changed file instead cost 27 s on 100 000 untracked
 * files, around each action and on every return to the window.
 */

// Files stat'ed at once; past a few dozen the disk is the limit, not the event loop.
const STAT_WIDTH = 32;
// A content digest reads files up to this size and fingerprints larger ones by metadata.
const READ_LIMIT = 1024 * 1024;

/** The refs Undo keeps track of. Remote-tracking refs are left out: no inverse reads or moves them, and a fetch would end the chain for work it never touched. `refs/twig/*` is 🌱 Twig's own bookkeeping: a discard moves it and its Undo does not move it back. */
const ownRefs = refs => refs.split('\n').filter(line => !line.startsWith('refs/remotes/') && !line.startsWith('refs/twig/')).join('\n');
const refsDigest = ({ own, branch, head, operation }) => createHash('sha256').update(own).update(`\0${branch ?? ''}\0${head ?? ''}\0${operation}`).digest('hex');

function reader({ cwd, log }) {
  return async argv => {
    const result = await runGit({ cwd, log, argv, operation: 'Background: Undo safety check' });
    if (result.code !== 0) throw new Error(ui`Could not verify the repository for Undo.`);
    return result.stdout;
  };
}
const REFS_ARGV = ['for-each-ref', '--format=%(refname)%00%(objectname)'];

/** The metadata of one path, or `missing`. A path reached through a link out of the worktree is refused; `folders` keeps one realpath per folder. */
async function stamp(root, file, folders) {
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(ui`Cannot verify this working-tree path.`);
  let info;
  try { info = await lstat(absolute, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { absolute, text: 'missing', info: null }; throw error; }
  const folder = path.dirname(absolute);
  if (!folders.has(folder)) {
    folders.set(folder, realpath(folder).then(real => {
      const parent = path.relative(root, real);
      if (parent.startsWith('..') || path.isAbsolute(parent)) throw new Error(ui`Cannot verify files through an external directory link.`);
    }));
  }
  await folders.get(folder);
  return { absolute, text: `${info.mode}:${info.size}:${info.ino}:${info.mtimeNs}:${info.ctimeNs}`, info };
}

async function stamps(cwd, paths) {
  const root = await realpath(cwd);
  const folders = new Map();
  return limited(paths, STAT_WIDTH, file => stamp(root, file, folders));
}

const hashOf = (paths, parts) => {
  const hash = createHash('sha256');
  paths.forEach((file, index) => hash.update(`${file}\0${parts[index]}\0`));
  return hash.digest('hex');
};

/** The metadata fingerprint of these paths: cheap enough to take on every return to the window. */
export async function stampFiles({ cwd, paths }) {
  return hashOf(paths, (await stamps(cwd, paths)).map(item => item.text));
}

async function readDigest({ absolute, text, info }) {
  if (!info) return text;
  if (info.isSymbolicLink()) return `link:${await readlink(absolute)}`;
  if (!info.isFile() || info.size > READ_LIMIT) return text;
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try { return createHash('sha256').update(await handle.readFile()).digest('hex'); } finally { await handle.close(); }
}

/**
 * The content fingerprint of these paths (metadata past READ_LIMIT). Compared
 * only when the metadata moved: a file put back by Undo, or saved unchanged,
 * has new times and the same content.
 */
export async function digestFiles({ cwd, paths }) {
  const items = await stamps(cwd, paths);
  return hashOf(paths, await limited(items, STAT_WIDTH, readDigest));
}

/** Both fingerprints of the paths an inverse rewrites, taken when it is recorded. */
export async function captureFiles({ cwd, paths }) {
  const [stamped, content] = await Promise.all([stampFiles({ cwd, paths }), digestFiles({ cwd, paths })]);
  return { stamp: stamped, content };
}

/** Where HEAD and the local refs are, and whether an operation is running: all an inverse that only moves a ref depends on. */
export async function captureRefs({ cwd, log }) {
  const read = reader({ cwd, log });
  const [refs, current, operation] = await Promise.all([read(REFS_ARGV), read(['branch', '--show-current']), loadOperationState({ cwd, log })]);
  const branch = current.trim() || null;
  const own = ownRefs(refs);
  const line = branch && refs.split('\n').find(item => item.startsWith(`refs/heads/${branch}\0`));
  const head = branch ? (line ? line.split('\0')[1] : null) : (await read(['rev-parse', 'HEAD'])).trim();
  return { refs: refsDigest({ own, branch, head, operation: operation.kind }), head, branch, operation: operation.kind };
}

/**
 * The whole state: `shape` is what Git says (status, refs, index, stashes), and
 * `digest` adds the metadata of every changed file. Two moments can have the
 * same shape and different digests; an inverse that rewrites files does that.
 */
export async function captureState({ cwd, log }) {
  const read = reader({ cwd, log });
  const [raw, refs, index, stash, operation] = await Promise.all([
    read(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']),
    read(REFS_ARGV), read(['ls-files', '--stage', '-z']), read(['stash', 'list', '--format=%H%x00%gs', '-z']),
    loadOperationState({ cwd, log })
  ]);
  const status = parseStatusV2(raw);
  const own = ownRefs(refs);
  // The status header's ahead/behind count (`# branch.ab`) is measured against
  // the remote-tracking branch, so it is left out for the same reason.
  const tokens = raw.split('\0');
  let headers = 0;
  while (headers < tokens.length && tokens[headers].startsWith('# ')) headers++;
  const local = tokens.filter((token, index) => index >= headers || !token.startsWith('# branch.ab ')).join('\0');
  const shape = createHash('sha256').update(local).update(own).update(index).update(stash).update(operation.kind).digest('hex');
  const paths = status.entries.map(entry => entry.path);
  const files = await stampFiles({ cwd, paths });
  const branch = status.branch.detached ? null : status.branch.name;
  const [stashOid = '', stashMessage = ''] = stash.replace(/\0$/, '').split('\0');
  return { digest: createHash('sha256').update(shape).update(files).digest('hex'), shape,
    refs: refsDigest({ own, branch, head: status.branch.oid, operation: operation.kind }),
    head: status.branch.oid, branch, paths, count: paths.length, clean: paths.length === 0,
    // Anything in the index that HEAD does not have: a mixed reset would lose it.
    staged: status.entries.some(entry => entry.kind === 'unmerged' || ((entry.kind === 'ordinary' || entry.kind === 'renamed') && entry.indexStatus !== '.')),
    stashOid, stashMessage, operation: operation.kind };
}
