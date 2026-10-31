import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { addWorktree, agentBranch, suggestWorktreePath } from '../../main/git/worktrees.js';
import { compareWorktrees, excludeAgentFolder, finishWorktree, isAgentFolder, loadWorktreeBoard, loadWorktreeCompareDiff, loadWorktreeFileDiff,
  loadWorktreeReview, planSquash, squashCommands, squashMessage, squashWorktree } from '../../main/git/worktree-board.js';
import { UndoService } from '../../main/undo.js';
import { createToolContext } from '../../main/mcp/context.js';
import { checkoutRoot, commonDir } from '../../main/mcp/context.js';
import { boardBadges, changesLine, compareCell, compareChoices, connectedLine, finishCommands, launchCommand, progressLine, squashReason } from '../../renderer/src/features/tools/tools-view.js';
import { waitingLine } from '../../renderer/src/features/proposal/proposal-view.js';

const A = 'a'.repeat(40);

// --- words and commands, without Git ----------------------------------------------------------------
assert.equal(launchCommand('/r/app/.claude/worktrees/fix'), "cd '/r/app/.claude/worktrees/fix' && claude");
assert.equal(launchCommand("/r/it's"), "cd '/r/it'\\''s' && claude", 'a quote in the folder survives POSIX quoting');
assert.equal(launchCommand('C:\\work\\app', 'win32'), 'cd /d "C:\\work\\app" && claude');
assert.equal(changesLine({ files: 0 }), 'Nothing uncommitted');
assert.equal(changesLine({ files: 3, insertions: 12, deletions: 4, untracked: 1, conflicts: 0 }), '3 files not committed · +12 −4 (1 new)');
assert.equal(changesLine({ files: 1, insertions: 0, deletions: 0, untracked: 1, conflicts: 0 }), '1 file not committed (1 new)');
assert.equal(progressLine({ ahead: 2, behind: 1, integrated: null }, 'main'), '2 commits ahead of main · 1 behind');
assert.equal(progressLine({ ahead: 1, behind: 0, integrated: 'squashed' }, 'main'), 'Squashed into main');
assert.equal(progressLine({ ahead: 0, behind: 3, integrated: 'merged' }, 'main'), 'Merged into main');
assert.equal(progressLine({ main: true, ahead: null }, 'main'), '');
assert.deepEqual(boardBadges({ agent: true, proposal: true, integrated: 'squashed' }), ['Agent', 'Commit proposed', 'Done']);
assert.match(squashReason({ main: true }, 'main'), /base/);
assert.match(squashReason({ branch: 'agent/x', ahead: 0 }, 'main'), /No commits ahead/);
assert.match(squashReason({ branch: 'agent/x', ahead: 2, integrated: 'squashed' }, 'main'), /already in main/);
assert.equal(squashReason({ branch: 'agent/x', ahead: 2 }, 'main'), undefined);
assert.deepEqual(finishCommands('/r/w', 'agent/x'), [['worktree', 'remove', '--', '/r/w'], ['branch', '-D', '--', 'agent/x']]);
assert.deepEqual(squashCommands(A), [['merge', '--squash', '--no-autostash', A], ['commit', '--file=-', '--cleanup=strip']]);
assert.throws(() => squashCommands('main'), TypeError, 'the squash names the tip by object id, never by a name Git could read as an option');
assert.equal(squashMessage([{ subject: 'feat: one', message: 'feat: one\n\nbody' }]), 'feat: one\n\nbody', 'one commit keeps its whole message');
assert.equal(squashMessage([{ subject: 'fix: two', message: 'fix: two' }, { subject: 'feat: one', message: 'feat: one' }]),
  'feat: one\n\n* feat: one\n* fix: two', 'several: the oldest subject, then every subject oldest first');
assert.equal(agentBranch('fix-login'), 'agent/fix-login');
assert.equal(isAgentFolder('/r/app', '/r/app/.claude/worktrees/x'), true);
assert.equal(isAgentFolder('/r/app', '/r/app-x'), false);
assert.deepEqual(boardBadges({ connected: { count: 1 } }), ['Agent connected']);
const ago = seconds => `${Math.round(Date.parse('2026-10-31T12:05:00Z') / 1000 - seconds)} s ago`;
assert.equal(connectedLine(null, ago), '');
assert.equal(connectedLine({ count: 1, lastCallAt: '2026-10-31T12:04:00Z' }, ago), 'Agent connected · last asked 60 s ago');
assert.equal(connectedLine({ count: 2, lastCallAt: null }, ago), '2 agents connected · has not asked anything yet');
assert.equal(compareCell(null), 'unchanged');
assert.equal(compareCell({ status: 'M', insertions: 3, deletions: 1 }), '+3 −1');
assert.equal(compareCell({ status: 'A', untracked: true }), 'new, not committed');
assert.equal(compareCell({ status: 'D', insertions: 0, deletions: 4 }), 'deleted');
assert.deepEqual(compareChoices([{ path: '/m', main: true }, { path: '/a' }, { path: '/b' }, { path: '/c', prunable: 'gone' }], '/a').map(entry => entry.path), ['/b']);
assert.equal(waitingLine(0), '');
assert.match(waitingLine(2), /^2 more proposals are waiting from other worktrees/);

// --- real Git -------------------------------------------------------------------------------------
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-board-')));
try {
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const cwd = path.join(root, 'app');
  const git = async (argv, at = cwd) => { const result = await runGit({ cwd: at, log, argv }); assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };
  await runGit({ cwd: root, log, argv: ['init', '--initial-branch=main', cwd] });
  for (const [key, value] of [['user.name', 'Twig Check'], ['user.email', 'check@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  await writeFile(path.join(cwd, 'app.txt'), 'one\ntwo\nthree\n');
  await writeFile(path.join(cwd, 'shared.txt'), 'base\n');
  await git(['add', '.']); await git(['commit', '-m', 'start']);
  const start = await git(['rev-parse', 'HEAD']);

  // An agent worktree: .claude/worktrees/<name> on agent/<name>, and the main checkout ignores it.
  const folder = await suggestWorktreePath({ main: cwd, branch: agentBranch('fix-login'), agent: true });
  assert.equal(folder, path.join(cwd, '.claude', 'worktrees', 'fix-login'));
  assert.equal((await addWorktree({ cwd, log, path: folder, branch: 'agent/fix-login', create: true, startPoint: start })).ok, true, 'Git makes the leading folders itself');
  assert.deepEqual(await excludeAgentFolder({ cwd, log }), { added: true, rule: '/.claude/worktrees/' });
  assert.match(await readFile(path.join(cwd, '.git', 'info', 'exclude'), 'utf8'), /\n\/\.claude\/worktrees\/\n$/);
  assert.equal(await git(['status', '--porcelain']), '', 'the main checkout does not list the agent folder');
  assert.deepEqual(await excludeAgentFolder({ cwd, log }), { added: false }, 'and the rule is added once');
  assert.equal(await suggestWorktreePath({ main: cwd, branch: agentBranch('fix-login'), agent: true }), `${folder}-2`, 'a taken name is numbered');

  // The agent works: two commits, then uncommitted edits and a new file.
  await writeFile(path.join(folder, 'app.txt'), 'one\nTWO\nthree\n'); await git(['commit', '-am', 'feat: shout two'], folder);
  await writeFile(path.join(folder, 'login.txt'), 'login\n'); await git(['add', '.'], folder); await git(['commit', '-m', 'feat: add login'], folder);
  await writeFile(path.join(folder, 'app.txt'), 'one\nTWO\nthree\nfour\n');
  await writeFile(path.join(folder, 'notes.md'), 'todo\n');
  // Meanwhile main moves on, elsewhere.
  await writeFile(path.join(cwd, 'readme.txt'), 'hello\n'); await git(['add', '.']); await git(['commit', '-m', 'docs: readme']);

  let board = await loadWorktreeBoard({ cwd, log, pending: new Set([folder]) });
  assert.equal(board.base, 'main');
  const mainCard = board.worktrees[0];
  assert.equal(mainCard.main, true); assert.equal(mainCard.ahead, null, 'the base is not compared with itself');
  let card = board.worktrees.find(entry => entry.path === folder);
  assert.deepEqual([card.agent, card.proposal, card.ahead, card.behind, card.integrated], [true, true, 2, 1, null]);
  assert.deepEqual(card.changes, { files: 2, untracked: 1, conflicts: 0, staged: 0, insertions: 1, deletions: 0 });
  assert.ok(card.lastActivity > Date.now() - 60_000, 'the last edit is now');
  assert.ok(!log.list().some(entry => entry.code !== 0 && entry.code !== null), 'a board read leaves nothing in the console that looks failed');

  // Everything it changed since it left main: the commits and the uncommitted work, main's own commit not among them.
  const review = await loadWorktreeReview({ cwd, log, folder });
  assert.equal(review.fork, start);
  assert.deepEqual(review.commits.map(commit => commit.subject), ['feat: add login', 'feat: shout two']);
  assert.deepEqual(review.files.map(file => [file.path, file.status, file.untracked, file.insertions]),
    [['app.txt', 'M', false, 2], ['login.txt', 'A', false, 1], ['notes.md', 'A', true, null]]);
  assert.equal(review.uncommitted, 2);
  const patch = await loadWorktreeFileDiff({ cwd, log, folder, path: 'app.txt' });
  assert.match(patch.patch, /^-two$/m); assert.match(patch.patch, /^\+TWO$/m); assert.match(patch.patch, /^\+four$/m, 'committed and uncommitted in one diff');
  assert.match((await loadWorktreeFileDiff({ cwd, log, folder, path: 'notes.md', untracked: true })).patch, /^\+todo$/m);
  await assert.rejects(loadWorktreeReview({ cwd, log, folder: cwd }), /main worktree is the base/);
  await assert.rejects(loadWorktreeReview({ cwd, log, folder: path.join(root, 'elsewhere') }), TypeError, 'only a worktree Git lists');
  await assert.rejects(loadWorktreeFileDiff({ cwd, log, folder, path: '../app/app.txt' }), TypeError);

  // The squash plan: commits, message, the uncommitted work left out, the exact commands.
  let plan = await planSquash({ cwd, log, folder });
  assert.equal(plan.problem, null);
  assert.deepEqual(plan.commits.map(commit => commit.subject), ['feat: add login', 'feat: shout two']);
  assert.equal(plan.message, 'feat: shout two\n\n* feat: shout two\n* feat: add login');
  assert.deepEqual(plan.commands, squashCommands(plan.branchOid));
  assert.match(plan.warnings[0], /^2 files in this worktree are not committed and will not be included/);
  // Staged work in main would go into the commit: refused until it is committed or unstaged.
  await writeFile(path.join(cwd, 'staged.txt'), 'mine\n'); await git(['add', 'staged.txt']);
  assert.match((await planSquash({ cwd, log, folder })).problem, /main has staged changes/);
  await git(['rm', '--cached', '-q', 'staged.txt']);
  plan = await planSquash({ cwd, log, folder });
  assert.match(plan.warnings[1], /main has uncommitted files/, 'an untracked file in main is only a warning');
  // A tip that moved since the dialog opened is refused.
  assert.equal((await squashWorktree({ cwd, log, folder, message: 'x', branchOid: A, baseOid: plan.baseOid })).moved, true);

  // The squash, through Undo in the base worktree: one commit on main with the person's message.
  const undo = new UndoService({ directory: path.join(root, 'undo'), log }); await undo.load();
  const message = 'feat: login, louder\n\nSquashed from the agent.';
  const squashed = await undo.perform(cwd, 'worktree:commit', [], () => squashWorktree({ cwd, log, folder, message, branchOid: plan.branchOid, baseOid: plan.baseOid }));
  assert.equal(squashed.ok, true, squashed.message);
  assert.equal(await git(['log', '-1', '--format=%B']), message);
  assert.equal(await git(['rev-parse', 'HEAD^']), plan.baseOid, 'one commit, on top of main');
  assert.equal(await git(['show', 'HEAD:app.txt']), 'one\nTWO\nthree', 'the agent’s committed change, not its uncommitted line');
  assert.equal(await git(['show', 'HEAD:login.txt']), 'login');
  assert.equal(await readFile(path.join(cwd, 'staged.txt'), 'utf8'), 'mine\n', 'main’s own untracked work is untouched');
  await assert.rejects(stat(path.join(cwd, '.git', 'SQUASH_MSG')), /ENOENT/, 'the commit cleared the squash state');
  board = await loadWorktreeBoard({ cwd, log });
  card = board.worktrees.find(entry => entry.path === folder);
  assert.equal(card.integrated, 'squashed', 'the board knows the work is in main');
  assert.equal(squashReason(card, 'main'), 'Its work is already in main');
  // Undo takes the commit back; the board then says the work is not in.
  const state = await undo.inspect(cwd);
  assert.equal(state.undo, true, state.undoReason);
  assert.equal((await undo.move(cwd, 'undo', true)).ok, true);
  assert.equal(await git(['rev-parse', 'HEAD']), plan.baseOid);
  assert.equal((await loadWorktreeBoard({ cwd, log })).worktrees.find(entry => entry.path === folder).integrated, null);
  assert.match((await finishWorktree({ cwd, log, folder })).message, /not in main yet/, 'finishing is refused while the work is not in main');
  await git(['reset', '-q', '--hard']);
  await rm(path.join(cwd, 'staged.txt'));
  assert.equal((await squashWorktree({ cwd, log, folder, message, branchOid: plan.branchOid, baseOid: plan.baseOid })).ok, true, 'and squashed again');

  // A squash that conflicts leaves main exactly as it was.
  const second = path.join(cwd, '.claude', 'worktrees', 'clash');
  assert.equal((await addWorktree({ cwd, log, path: second, branch: 'agent/clash', create: true, startPoint: start })).ok, true);
  await writeFile(path.join(second, 'shared.txt'), 'agent\n'); await git(['commit', '-am', 'agent edits shared'], second);
  await writeFile(path.join(cwd, 'shared.txt'), 'person\n'); await git(['commit', '-am', 'person edits shared']);
  await writeFile(path.join(cwd, 'local.txt'), 'keep me\n');
  const before = await git(['rev-parse', 'HEAD']);
  const clashPlan = await planSquash({ cwd, log, folder: second });
  const clash = await squashWorktree({ cwd, log, folder: second, message: 'agent edits shared', branchOid: clashPlan.branchOid, baseOid: clashPlan.baseOid });
  assert.equal(clash.ok, false); assert.deepEqual(clash.conflicts, ['shared.txt']); assert.match(clash.message, /conflicts with main in shared\.txt\. Nothing changed/);
  assert.equal(await git(['rev-parse', 'HEAD']), before);
  assert.equal(await git(['status', '--porcelain']), '?? local.txt', 'no conflict left behind, the untracked file kept');
  assert.equal(await readFile(path.join(cwd, 'shared.txt'), 'utf8'), 'person\n');

  // A commit hook that refuses puts main back too.
  const third = path.join(cwd, '.claude', 'worktrees', 'hooked');
  await addWorktree({ cwd, log, path: third, branch: 'agent/hooked', create: true, startPoint: before });
  await writeFile(path.join(third, 'hooked.txt'), 'x\n'); await git(['add', '.'], third); await git(['commit', '-m', 'hooked'], third);
  await mkdir(path.join(root, 'hooks'), { recursive: true });
  await writeFile(path.join(root, 'hooks', 'pre-commit'), '#!/bin/sh\necho "no commits today" >&2\nexit 1\n', { mode: 0o755 });
  await git(['config', 'core.hooksPath', path.join(root, 'hooks')]);
  const hookPlan = await planSquash({ cwd, log, folder: third });
  const hooked = await squashWorktree({ cwd, log, folder: third, message: 'hooked', branchOid: hookPlan.branchOid, baseOid: hookPlan.baseOid });
  assert.equal(hooked.ok, false); assert.match(hooked.message, /Not committed, main is as it was[\s\S]*no commits today/);
  assert.equal(await git(['status', '--porcelain']), '?? local.txt');
  await git(['config', 'core.hooksPath', '']);

  // --- MCP: an agent in a worktree reads its own worktree ----------------------------------------
  const repositories = { snapshot: () => ({ repositories: [{ id: cwd, name: 'app', path: cwd, available: true }] }) };
  const ctx = createToolContext({ repositories, journal: log, getActiveId: () => cwd, getUiContext: () => null });
  assert.equal(checkoutRoot(path.join(folder, 'src', 'deep')), folder, 'a folder inside the worktree that does not exist yet still climbs to it');
  assert.equal(commonDir(folder), await realpath(path.join(cwd, '.git')));
  const inside = ctx.forClient({ cwd: folder }).repository();
  assert.deepEqual([inside.id, inside.path, inside.name, inside.implicit, inside.worktreeOf], [folder, folder, 'fix-login (worktree of app)', false, cwd]);
  await mkdir(path.join(folder, 'src'), { recursive: true });
  assert.equal(ctx.forClient({ cwd: path.join(folder, 'src') }).repository().path, folder, 'from a subfolder too');
  assert.equal(ctx.forClient({ cwd }).repository().path, cwd, 'the main checkout is still itself');
  assert.equal(ctx.forClient({ cwd: path.join(cwd, '.claude') }).repository().path, cwd, 'a plain folder of the main checkout is the main checkout');
  assert.equal(ctx.repository(path.join(folder, 'app.txt')).path, folder, 'a path inside the worktree names it');
  // A worktree next to the repository, nobody connected: still found through its .git file.
  const sibling = `${cwd}-side`;
  await addWorktree({ cwd, log, path: sibling, branch: 'side', create: true, startPoint: start });
  assert.equal(ctx.forClient({ cwd: sibling }).repository().path, sibling);
  // Through a symlinked folder, as macOS shows /var for /private/var.
  await symlink(folder, path.join(root, 'link'));
  assert.equal(ctx.forClient({ cwd: path.join(root, 'link') }).repository().path, folder);
  // A .git file that only names the repository's worktree folder is not that worktree.
  const forged = path.join(root, 'forged');
  await mkdir(forged);
  await writeFile(path.join(forged, '.git'), `gitdir: ${path.join(cwd, '.git', 'worktrees', 'fix-login')}\n`);
  const fallback = ctx.forClient({ cwd: forged }).repository();
  assert.equal(fallback.path, cwd); assert.equal(fallback.implicit, true, 'it falls back to the open repository, saying so');
  assert.match(fallback.note, /not a repository connected/);

  // --- two agents on the same task, side by side ---------------------------------------------------
  const other = path.join(cwd, '.claude', 'worktrees', 'fix-login-b');
  await addWorktree({ cwd, log, path: other, branch: 'agent/fix-login-b', create: true, startPoint: start });
  await writeFile(path.join(other, 'app.txt'), 'one\nTwo!\nthree\n'); await git(['commit', '-am', 'feat: a quieter two'], other);
  await writeFile(path.join(other, 'login.txt'), 'login\n');
  const compared = await compareWorktrees({ cwd, log, left: folder, right: other });
  assert.deepEqual([compared.left.commits, compared.right.commits, compared.right.uncommitted], [2, 1, 1]);
  assert.deepEqual(compared.files.map(row => [row.path, compareCell(row.left), compareCell(row.right)]), [
    ['app.txt', '+2 −1', '+1 −1'], ['login.txt', '+1 −0', 'new, not committed'], ['notes.md', 'new, not committed', 'unchanged']]);
  const both = await loadWorktreeCompareDiff({ cwd, log, left: folder, right: other, path: 'app.txt' });
  assert.match(both.patch, /^@@ /, 'the patch starts at the hunk, without absolute paths in a header');
  assert.match(both.patch, /^-TWO$/m); assert.match(both.patch, /^\+Two!$/m); assert.match(both.patch, /^-four$/m, 'the left one’s uncommitted line is in it');
  assert.equal((await loadWorktreeCompareDiff({ cwd, log, left: folder, right: other, path: 'login.txt' })).same, true, 'the same login.txt in both');
  assert.match((await loadWorktreeCompareDiff({ cwd, log, left: folder, right: other, path: 'notes.md' })).patch, /^-todo$/m, 'only the left one has notes.md');
  await symlink('/etc', path.join(other, 'etc-link'));
  assert.match((await loadWorktreeCompareDiff({ cwd, log, left: folder, right: other, path: 'etc-link/hosts' })).note ?? '', /leads outside|not a regular file/, 'a link out of the worktree is not followed');
  await rm(path.join(other, 'etc-link'));
  await assert.rejects(compareWorktrees({ cwd, log, left: folder, right: folder }), TypeError);
  await assert.rejects(loadWorktreeCompareDiff({ cwd, log, left: folder, right: cwd, path: 'app.txt' }), /main worktree is the base/);
  await assert.rejects(loadWorktreeCompareDiff({ cwd, log, left: folder, right: other, path: '../../app.txt' }), TypeError);
  // The board marks the worktrees an agent is connected from.
  board = await loadWorktreeBoard({ cwd, log, agents: [{ path: other, connectedAt: '2026-10-31T12:00:00Z', lastCallAt: '2026-10-31T12:01:00Z' }, { path: other, connectedAt: '2026-10-31T12:02:00Z', lastCallAt: null }] });
  assert.deepEqual(board.worktrees.find(entry => entry.path === other).connected, { count: 2, lastCallAt: '2026-10-31T12:01:00Z', connectedAt: '2026-10-31T12:00:00Z' });
  assert.equal(board.worktrees.find(entry => entry.path === folder).connected, null);
  await git(['worktree', 'remove', '--force', other]);

  // --- finishing: the worktree and its branch go, once the work is in main -----------------------
  await writeFile(path.join(folder, 'notes.md'), 'todo\n');
  const dirty = await finishWorktree({ cwd, log, folder });
  assert.equal(dirty.ok, false); assert.equal(dirty.dirty, true, 'Git refuses a worktree with uncommitted files');
  await rm(path.join(folder, 'notes.md')); await git(['checkout', '--', 'app.txt'], folder);
  const finished = await finishWorktree({ cwd, log, folder });
  assert.deepEqual(finished, { ok: true, path: folder, branch: 'agent/fix-login' });
  await assert.rejects(stat(folder), /ENOENT/);
  assert.equal((await runGit({ cwd, log, argv: ['rev-parse', '--verify', '--quiet', 'refs/heads/agent/fix-login'] })).code, 1, 'the branch is gone');
  assert.equal(await git(['for-each-ref', 'refs/twig/']), '', 'and so is the squash bookkeeping');
  // A branch merged the ordinary way counts as done too.
  await git(['merge', '-q', '--no-edit', 'side']);
  assert.equal((await loadWorktreeBoard({ cwd, log })).worktrees.find(entry => entry.path === sibling).integrated, 'merged');
  assert.equal((await finishWorktree({ cwd, log, folder: sibling })).ok, true);
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Worktree board checks passed: words and commands, agent folder and its exclude rule, board counts and divergence, review since the fork point, squash with Undo, conflict and hook roll back, MCP worktree resolution and a forged .git file, two worktrees compared, connected agents, finish.');
