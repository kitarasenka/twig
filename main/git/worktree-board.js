import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { runGit } from './exec.js';
import { parseStatusV2 } from './status-parser.js';
import { buildStatusArgv, loadUntrackedDiff } from './worktree.js';
import { parseNumstat } from './numstat.js';
import { parseChangedFiles, validateFile, validateOid } from './commit.js';
import { buildDeleteBranchArgv, validateRefName } from './refs-ops.js';
import { buildCommitArgv, createCommit, gitReason, validateCommitMessage } from './commit-ops.js';
import { loadOperationState } from './operation-state.js';
import { AGENT_FOLDER, findWorktree, loadWorktrees, removeWorktree } from './worktrees.js';

/**
 * The Worktrees board: what each worktree of a repository holds — commits
 * ahead of the base branch, uncommitted files, when it last changed — and
 * the way an agent's work comes back: everything it changed since it forked,
 * one squashed commit on the base branch, then the worktree and its branch
 * removed. The base is the branch checked out in the main worktree.
 *
 * Every read here exits 0 on success, so a board refresh never leaves an
 * entry in the console that "Show output" could mistake for a failure.
 */

const PLAIN = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];
// Hidden bookkeeping (never drawn, never watched): which commit a squash made
// and what the branch tip was then, so the board can say the work is in.
const SQUASH_REFS = 'refs/twig/squash';
const SQUASH_TIP_REFS = 'refs/twig/squash-tip';
const COMMIT_LIMIT = 500;
const STAT_LIMIT = 200;

const heads = name => `refs/heads/${validateRefName(name)}`;

async function read(cwd, log, argv, operation) {
  const result = await runGit({ cwd, log, argv, operation });
  if (result.code !== 0) throw new Error(`${operation} failed. See the command console.`);
  return result.stdout;
}

/** `git status` of one worktree, counted: files, untracked, conflicts, and their paths. */
async function readChanges(folder, log) {
  const status = parseStatusV2(await read(folder, log, buildStatusArgv({ allUntracked: true }), 'Read worktree changes'));
  const entries = status.entries.filter(entry => entry.kind !== 'ignored');
  return {
    paths: entries.map(entry => entry.path),
    files: entries.length,
    untracked: entries.filter(entry => entry.kind === 'untracked').length,
    conflicts: entries.filter(entry => entry.kind === 'unmerged').length,
    staged: entries.filter(entry => entry.kind !== 'untracked' && entry.kind !== 'unmerged' && entry.indexStatus !== '.').length,
    unborn: status.branch.unborn
  };
}

/** Lines added and removed against HEAD, staged or not; untracked files have no counts. */
async function readLineTotals(folder, log, unborn) {
  if (unborn) return { insertions: 0, deletions: 0 };
  const counts = parseNumstat(await read(folder, log, ['diff', ...PLAIN, '--numstat', '-z', 'HEAD', '--'], 'Read worktree change sizes'));
  let insertions = 0;
  let deletions = 0;
  for (const count of counts.values()) { insertions += count.insertions ?? 0; deletions += count.deletions ?? 0; }
  return { insertions, deletions };
}

/** The newest modification time among the changed files, or null. */
async function lastEdit(folder, paths) {
  let newest = null;
  for (const file of paths.slice(0, STAT_LIMIT)) {
    try {
      const info = await lstat(path.join(folder, file));
      if (newest === null || info.mtimeMs > newest) newest = info.mtimeMs;
    } catch { /* deleted: no time to read */ }
  }
  return newest;
}

/** Commit times of several commits in one call. */
async function commitTimes(cwd, log, oids) {
  const wanted = [...new Set(oids.filter(Boolean))].map(validateOid);
  if (!wanted.length) return new Map();
  const output = await read(cwd, log, ['log', '--no-walk=unsorted', '--format=%H %ct', ...wanted, '--'], 'Read worktree commit times');
  return new Map(output.split('\n').filter(Boolean).map(line => { const [oid, time] = line.split(' '); return [oid, Number(time) * 1000]; }));
}

/** The squash records: branch name → { squash, tip }. */
async function readSquashRecords(cwd, log) {
  const output = await read(cwd, log, ['for-each-ref', '--format=%(refname)%00%(objectname)', SQUASH_REFS, SQUASH_TIP_REFS], 'Read squashed worktree branches');
  const records = new Map();
  for (const line of output.split('\n').filter(Boolean)) {
    const [ref, oid] = line.split('\0');
    const [prefix, field] = ref.startsWith(`${SQUASH_TIP_REFS}/`) ? [SQUASH_TIP_REFS, 'tip'] : [SQUASH_REFS, 'squash'];
    const branch = ref.slice(prefix.length + 1);
    records.set(branch, { ...records.get(branch), [field]: oid });
  }
  return records;
}

/**
 * How far `branch` is from `base`, and whether its work is already in
 * `base`: merged (nothing ahead), or squashed by 🌱 Twig at the tip it still
 * has. A squash done elsewhere (a forge's squash merge) is not recognised.
 */
async function integration({ cwd, log, base, branch, tip, records }) {
  const counts = (await read(cwd, log, ['rev-list', '--left-right', '--count', `${heads(base)}...${heads(branch)}`, '--'], 'Read worktree branch divergence')).trim().split(/\s+/).map(Number);
  const [behind, ahead] = counts;
  if (ahead === 0) return { ahead, behind, integrated: 'merged' };
  const record = records.get(branch);
  if (record?.squash && record.tip === tip) {
    const missing = (await read(cwd, log, ['rev-list', '--count', record.squash, '--not', heads(base), '--'], 'Read whether a squashed branch is in the base')).trim();
    if (missing === '0') return { ahead, behind, integrated: 'squashed', squash: record.squash };
  }
  return { ahead, behind, integrated: null };
}

/** At most `limit` of `items` at a time through `run`, results in order. */
async function limited(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]); }
  }));
  return results;
}

/** True if `folder` is inside the main worktree's agent folder (`.claude/worktrees`). */
export function isAgentFolder(main, folder) {
  const relative = path.relative(path.join(main, AGENT_FOLDER), folder);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

const real = folder => { try { return realpathSync.native(folder); } catch { return path.resolve(folder); } };

/**
 * Every worktree, described for the board. `pending` is the set of folders
 * with a commit proposal waiting, `agents` the agents connected over MCP with
 * the folder they work in — both from the MCP service — so a card can say so.
 * @param {{ cwd: string, log: object, pending?: Set<string>, agents?: Array<{ path: string, lastCallAt: ?string, connectedAt: string }> }} options
 */
export async function loadWorktreeBoard({ cwd, log, pending = new Set(), agents = [] }) {
  const waiting = new Set([...pending].map(real));
  const connected = new Map();
  for (const agent of agents) {
    const key = real(agent.path);
    const known = connected.get(key);
    connected.set(key, { count: (known?.count ?? 0) + 1, lastCallAt: known?.lastCallAt ?? agent.lastCallAt ?? null, connectedAt: known?.connectedAt ?? agent.connectedAt });
  }
  const list = await loadWorktrees({ cwd, log });
  const main = list[0];
  const base = main && !main.bare && main.branch ? main.branch : null;
  const records = await readSquashRecords(cwd, log);
  const times = await commitTimes(cwd, log, list.filter(entry => !entry.prunable && !entry.bare).map(entry => entry.head));
  const worktrees = await limited(list, 3, async entry => {
    const card = { ...entry, agent: isAgentFolder(main.path, entry.path), proposal: waiting.has(real(entry.path)),
      connected: connected.get(real(entry.path)) ?? null,
      changes: null, ahead: null, behind: null, integrated: null, lastActivity: times.get(entry.head) ?? null };
    if (entry.prunable || entry.bare) return card;
    const changes = await readChanges(entry.path, log);
    const lines = await readLineTotals(entry.path, log, changes.unborn);
    const edited = await lastEdit(entry.path, changes.paths);
    card.changes = { files: changes.files, untracked: changes.untracked, conflicts: changes.conflicts, staged: changes.staged, ...lines };
    if (edited !== null && (card.lastActivity === null || edited > card.lastActivity)) card.lastActivity = edited;
    if (!entry.main && base && entry.branch && entry.branch !== base) {
      Object.assign(card, await integration({ cwd, log, base, branch: entry.branch, tip: entry.head, records }));
    }
    return card;
  });
  return { base, main: main?.path ?? null, worktrees };
}

/** The worktree the screen named, as Git lists it now, with the main one beside it. */
async function agentWorktree({ cwd, log, folder }) {
  const entry = await findWorktree({ cwd, log, path: folder });
  if (entry.main) throw new Error('The main worktree is the base; review a worktree next to it.');
  if (entry.bare || entry.prunable) throw new Error('This worktree has no files to show.');
  const list = await loadWorktrees({ cwd, log });
  return { entry, main: list[0], base: list[0].branch || null };
}

/** Where the worktree's branch left the base: the commit everything is compared with. */
async function forkPoint(folder, log, base) {
  if (!base) return null;
  const result = await runGit({ cwd: folder, log, argv: ['merge-base', heads(base), 'HEAD'], operation: 'Read where the worktree branch started' });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * Everything the worktree changed since its branch left the base: its commits
 * and what is not committed yet, as one list of files — what the agent did,
 * in one place. Untracked files are listed by name.
 * @param {{ cwd: string, log: object, folder: string }} options
 */
export async function loadWorktreeReview({ cwd, log, folder }) {
  const { entry, base } = await agentWorktree({ cwd, log, folder });
  const fork = await forkPoint(entry.path, log, base);
  const against = fork || (entry.head ? 'HEAD' : null);
  const status = parseStatusV2(await read(entry.path, log, buildStatusArgv({ allUntracked: true }), 'Read worktree changes'));
  const untracked = status.entries.filter(item => item.kind === 'untracked').map(item => item.path);
  const files = against ? parseChangedFiles(await read(entry.path, log, ['diff', ...PLAIN, '--name-status', '-z', against, '--'], 'Read what the worktree changed')) : [];
  const counts = against ? parseNumstat(await read(entry.path, log, ['diff', ...PLAIN, '--numstat', '-z', against, '--'], 'Read what the worktree changed, sizes')) : new Map();
  const commits = fork ? await readCommits(entry.path, log, `${fork}..HEAD`) : [];
  const uncommitted = status.entries.filter(item => item.kind !== 'ignored').length;
  return {
    folder: entry.path, branch: entry.branch, base, fork, commits, uncommitted,
    files: [
      ...files.map(file => ({ ...file, untracked: false, insertions: counts.get(file.path)?.insertions ?? null, deletions: counts.get(file.path)?.deletions ?? null, binary: Boolean(counts.get(file.path)?.binary) })),
      // An agent committing while this reads can leave a file in both answers; the diff is the later word.
      ...untracked.filter(file => !files.some(item => item.path === file)).map(file => ({ path: file, status: 'A', untracked: true, insertions: null, deletions: null, binary: false }))
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  };
}

/** One file's patch since the fork point, or an untracked file as an added one. */
export async function loadWorktreeFileDiff({ cwd, log, folder, path: file, untracked = false }) {
  validateFile(file);
  const { entry, base } = await agentWorktree({ cwd, log, folder });
  if (untracked) {
    const patch = await loadUntrackedDiff({ cwd: entry.path, log, path: file });
    if (patch.directory) return { patch: '', note: 'A folder Git lists as one entry.' };
    if (patch.tooLarge) return { patch: '', note: `${patch.size} bytes, too large to show.` };
    return { patch: patch.text, note: null };
  }
  const against = (await forkPoint(entry.path, log, base)) || 'HEAD';
  const patch = await read(entry.path, log, ['diff', ...PLAIN, '--src-prefix=a/', '--dst-prefix=b/', against, '--', `:(literal)${file}`], 'Read a worktree file diff');
  return { patch, note: null };
}

async function readCommits(cwd, log, range) {
  const output = await read(cwd, log, ['log', `--max-count=${COMMIT_LIMIT}`, '-z', '--format=%H%x1f%B', range, '--'], 'Read the worktree branch commits');
  return output.split('\0').filter(Boolean).map(record => {
    const [oid, message = ''] = record.split('\x1f');
    const text = message.replace(/\n+$/, '');
    return { oid: oid.trim(), subject: text.split('\n')[0], message: text };
  });
}

/**
 * The message a squash starts with: one commit's own message, or for several
 * the oldest subject, then each subject as a bullet, oldest first.
 * @param {Array<{ subject: string, message: string }>} commits newest first, as `git log` gives them
 */
export function squashMessage(commits) {
  if (!commits.length) return '';
  if (commits.length === 1) return commits[0].message;
  const oldest = [...commits].reverse();
  return `${oldest[0].subject}\n\n${oldest.map(commit => `* ${commit.subject}`).join('\n')}`;
}

/** The commands a squash runs, in the base worktree. Exported for the check and the dialog. */
export function squashCommands(branchOid) {
  return [['merge', '--squash', '--no-autostash', validateOid(branchOid)], buildCommitArgv()];
}

/**
 * What squashing the worktree's branch into the base would do, and why it
 * cannot be done now: no commits ahead, or the base worktree mid-operation,
 * with conflicts or with staged changes (they would go into the commit).
 * Uncommitted work in the agent's worktree is not part of a squash — it says so.
 */
export async function planSquash({ cwd, log, folder }) {
  const { entry, main, base } = await agentWorktree({ cwd, log, folder });
  const plan = { folder: entry.path, branch: entry.branch, base, basePath: main.path, branchOid: entry.head, baseOid: main.head,
    commits: [], message: '', commands: [], problem: null, warnings: [] };
  if (!entry.branch) return { ...plan, problem: 'This worktree is not on a branch.' };
  if (!base) return { ...plan, problem: 'The main worktree is not on a branch, so there is nothing to squash into.' };
  if (entry.branch === base) return { ...plan, problem: `This worktree is on ${base} itself.` };
  plan.commits = await readCommits(cwd, log, `${heads(base)}..${heads(entry.branch)}`);
  plan.message = squashMessage(plan.commits);
  plan.commands = squashCommands(entry.head);
  const own = await readChanges(entry.path, log);
  if (own.files) plan.warnings.push(`${own.files === 1 ? '1 file' : `${own.files} files`} in this worktree ${own.files === 1 ? 'is' : 'are'} not committed and will not be included. Commit ${own.files === 1 ? 'it' : 'them'} first to bring ${own.files === 1 ? 'it' : 'them'} along.`);
  if (!plan.commits.length) return { ...plan, problem: `${entry.branch} has no commits that ${base} does not have.` };
  const operation = await loadOperationState({ cwd: main.path, log });
  if (operation.kind !== 'none') return { ...plan, problem: `A ${operation.kind} is in progress in ${base}. Finish or abort it first.` };
  const there = await readChanges(main.path, log);
  if (there.conflicts) return { ...plan, problem: `${base} has unresolved conflicts. Resolve them first.` };
  if (there.staged) return { ...plan, problem: `${base} has staged changes; they would go into the squashed commit. Commit or unstage them first.` };
  if (there.files) plan.warnings.push(`${base} has uncommitted files. Git stops if the squash would change any of them.`);
  return plan;
}

/**
 * Squashes the worktree's branch into the base: `git merge --squash` and one
 * `git commit` in the base worktree, with the person's message. The tips the
 * dialog showed must still be the tips. A conflict, a refusal or a failed
 * commit (a hook) puts the base back as it was with `git reset --merge`,
 * which keeps uncommitted work Git did not touch.
 * @param {{ cwd: string, log: object, folder: string, message: string, branchOid: string, baseOid: string }} options
 */
export async function squashWorktree({ cwd, log, folder, message, branchOid, baseOid }) {
  validateOid(branchOid); validateOid(baseOid);
  const check = validateCommitMessage(message);
  if (!check.valid) throw new TypeError(check.error);
  const plan = await planSquash({ cwd, log, folder });
  if (plan.problem) return { ok: false, message: plan.problem };
  if (plan.branchOid !== branchOid || plan.baseOid !== baseOid) return { ok: false, moved: true, message: `${plan.branch} or ${plan.base} moved since you opened this. Review it again.` };
  const target = plan.basePath;
  const restore = () => runGit({ cwd: target, log, argv: ['reset', '--merge'], operation: 'Put the base back after a squash that did not finish' });
  const merged = await runGit({ cwd: target, log, argv: plan.commands[0], operation: `Squash ${plan.branch} into ${plan.base}` });
  if (merged.code !== 0) {
    const after = parseStatusV2(await read(target, log, buildStatusArgv(), 'Read the base after the squash'));
    const conflicts = after.entries.filter(entry => entry.kind === 'unmerged').map(entry => entry.path);
    await restore();
    if (conflicts.length) {
      return { ok: false, conflicts, message: `Squashing ${plan.branch} conflicts with ${plan.base} in ${conflicts.join(', ')}. Nothing changed. Merge or rebase it from the graph to resolve the conflicts.` };
    }
    return { ok: false, message: `Git refused the squash: ${gitReason(merged) || 'see the command console.'}` };
  }
  try {
    await createCommit({ cwd: target, log, message });
  } catch (error) {
    await restore();
    return { ok: false, message: `Not committed, ${plan.base} is as it was: ${error.message}${error.detail ? `\n${error.detail}` : ''}` };
  }
  const head = (await read(target, log, ['rev-parse', 'HEAD'], 'Read the squashed commit')).trim();
  await read(cwd, log, ['update-ref', '-m', `🌱 Twig: squashed ${plan.branch}`, `${SQUASH_REFS}/${plan.branch}`, head], 'Remember the squash');
  await read(cwd, log, ['update-ref', '-m', `🌱 Twig: squashed ${plan.branch}`, `${SQUASH_TIP_REFS}/${plan.branch}`, branchOid], 'Remember the squashed tip');
  return { ok: true, oid: head, branch: plan.branch, base: plan.base, basePath: target };
}

/**
 * Removes a worktree whose work is in the base, and its branch with it. Git
 * refuses while the worktree has uncommitted files; the branch is deleted
 * with -D only because its changes are known to be in the base (merged, or
 * squashed by 🌱 Twig at the same tip).
 */
export async function finishWorktree({ cwd, log, folder }) {
  const { entry, base } = await agentWorktree({ cwd, log, folder });
  if (!entry.branch || !base) return { ok: false, message: 'This worktree is not on a branch next to a base branch.' };
  const records = await readSquashRecords(cwd, log);
  const state = await integration({ cwd, log, base, branch: entry.branch, tip: entry.head, records });
  if (!state.integrated) return { ok: false, message: `${entry.branch} has work that is not in ${base} yet. Squash it first, or remove only the worktree.` };
  const removed = await removeWorktree({ cwd, log, path: entry.path });
  if (!removed.ok) return removed;
  const deleted = await runGit({ cwd, log, argv: buildDeleteBranchArgv(entry.branch, true), operation: `Delete branch ${entry.branch}` });
  for (const prefix of [SQUASH_REFS, SQUASH_TIP_REFS]) {
    if (records.get(entry.branch)?.[prefix === SQUASH_REFS ? 'squash' : 'tip']) {
      await runGit({ cwd, log, argv: ['update-ref', '-d', `${prefix}/${entry.branch}`], operation: 'Forget the squash' });
    }
  }
  if (deleted.code !== 0) return { ok: false, path: entry.path, message: `The worktree is removed, but Git kept the branch: ${gitReason(deleted)}` };
  return { ok: true, path: entry.path, branch: entry.branch };
}

/**
 * Makes the main checkout ignore its agent worktrees, if nothing does yet:
 * `/.claude/worktrees/` goes into `.git/info/exclude`, a local file Git never
 * commits. Journaled like a command, as the .gitignore edit is.
 */
export async function excludeAgentFolder({ cwd, log }) {
  const probe = await read(cwd, log, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z', '--', `${AGENT_FOLDER}/`], 'Read whether agent worktrees are ignored');
  if (probe.split('\0').some(item => item && `${AGENT_FOLDER}/`.startsWith(item.replace(/\/?$/, '/')))) return { added: false };
  const common = path.resolve(cwd, (await read(cwd, log, ['rev-parse', '--git-common-dir'], 'Read the repository folder')).trim());
  const file = path.join(common, 'info', 'exclude');
  const rule = `/${AGENT_FOLDER}/`;
  let content = '';
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return { added: false, skipped: true };
    content = await readFile(file, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (content.split(/\r?\n/).includes(rule)) return { added: false };
  const next = `${content}${content && !content.endsWith('\n') ? '\n' : ''}${rule}\n`;
  await journaled({ log, cwd, argv: ['append', '.git/info/exclude', rule], operation: 'Ignore agent worktrees', output: `${rule}\n`,
    run: async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, next); } });
  return { added: true, rule };
}

/** One journal entry for a write that is not a Git command, shaped like one so the console shows it. */
async function journaled({ log, cwd, argv, operation, output, run }) {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  await log.start({ id, executable: '🌱 Twig', argv, cwd, startedAt, operation });
  try {
    await run();
    await log.output(id, 'stdout', output);
    await log.finish(id, { code: 0, stdout: output, stderr: '', cancelled: false, ms: Math.round(performance.now() - started), startedAt });
  } catch (error) {
    await log.output(id, 'stderr', `${error.message}\n`);
    await log.finish(id, { code: 1, stdout: '', stderr: error.message, cancelled: false, ms: Math.round(performance.now() - started), startedAt });
    throw new Error('Could not write .git/info/exclude. See the command console.');
  }
}

const COMPARE_LIMIT = 1024 * 1024;
const summary = review => ({ folder: review.folder, branch: review.branch, fork: review.fork,
  commits: review.commits.length, uncommitted: review.uncommitted, files: review.files.length });

/**
 * Two worktrees side by side — two agents given the same task: every file
 * either one changed since its branch left the base, with each side's status
 * and line counts (null on a side that did not touch it).
 * @param {{ cwd: string, log: object, left: string, right: string }} options
 */
export async function compareWorktrees({ cwd, log, left, right }) {
  if (typeof left !== 'string' || typeof right !== 'string' || path.resolve(left) === path.resolve(right)) throw new TypeError('Choose two different worktrees');
  const [a, b] = await Promise.all([loadWorktreeReview({ cwd, log, folder: left }), loadWorktreeReview({ cwd, log, folder: right })]);
  const rows = new Map();
  for (const [side, review] of [['left', a], ['right', b]]) {
    for (const file of review.files) {
      const row = rows.get(file.path) ?? { path: file.path, left: null, right: null };
      row[side] = { status: file.status, untracked: file.untracked, insertions: file.insertions, deletions: file.deletions, binary: file.binary };
      rows.set(file.path, row);
    }
  }
  return { base: a.base, left: summary(a), right: summary(b),
    files: [...rows.values()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)) };
}

/** One side of a comparison: the file on disk in that worktree, or null where it does not exist. */
async function compareSide(folder, file) {
  const full = path.join(folder, file);
  let info;
  try { info = await lstat(full); } catch (error) { if (error.code === 'ENOENT') return { path: null }; throw error; }
  if (!info.isFile()) return { note: `${file} is not a regular file in ${path.basename(folder)}.` };
  // A folder on the way could be a link leading out of the worktree.
  const [root, resolved] = [realpathSync.native(folder), realpathSync.native(full)];
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { note: `${file} leads outside ${path.basename(folder)}.` };
  if (info.size > COMPARE_LIMIT) return { note: `${file} is larger than 1 MB in ${path.basename(folder)}.` };
  return { path: resolved };
}

/**
 * The same file in two worktrees, as one diff: − lines are the left one's,
 * + lines the right one's, uncommitted work included — `git diff --no-index`
 * on the two files on disk. Its header names absolute paths, so the patch
 * starts at the first hunk.
 */
export async function loadWorktreeCompareDiff({ cwd, log, left, right, path: file }) {
  validateFile(file);
  if (typeof left !== 'string' || typeof right !== 'string') throw new TypeError('Choose two different worktrees');
  const [a, b] = await Promise.all([agentWorktree({ cwd, log, folder: left }), agentWorktree({ cwd, log, folder: right })]);
  const sides = await Promise.all([compareSide(a.entry.path, file), compareSide(b.entry.path, file)]);
  const note = sides.find(side => side.note)?.note;
  if (note) return { patch: '', note, same: false };
  if (!sides[0].path && !sides[1].path) return { patch: '', note: 'Neither worktree has this file now.', same: false };
  const result = await runGit({ cwd, log, operation: 'Read a file compared across two worktrees',
    argv: ['diff', '--no-index', ...PLAIN, '--', sides[0].path ?? '/dev/null', sides[1].path ?? '/dev/null'] });
  // `--no-index` answers 1 when the files differ, which is the usual case here.
  if (result.code !== 0 && result.code !== 1) throw new Error('Git could not compare the two files.');
  if (result.code === 0) return { patch: '', note: null, same: true };
  const start = result.stdout.search(/^(?:@@ |Binary files )/m);
  const body = start < 0 ? '' : result.stdout.slice(start);
  return { patch: body, note: null, same: false, binary: body.startsWith('Binary files ') };
}
