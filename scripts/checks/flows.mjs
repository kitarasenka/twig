import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../../main/git/exec.js';
import { CommandLog } from '../../main/command-log.js';
import { RepositoryStore } from '../../main/store.js';
import { MarksStore } from '../../main/marks-store.js';
import { AutomationsStore } from '../../main/automations-store.js';
import { AutomationRunsStore } from '../../main/automation-runs-store.js';
import { UndoService } from '../../main/undo.js';
import { createRepositoryService } from '../../main/git/repository.js';
import { buildSyncArgv, pushRefusal, runSync } from '../../main/git/sync.js';
import { STASH_CONFLICT, stashPop, stashPush } from '../../main/git/commit-ops.js';
import { runStashAction, loadStashes } from '../../main/git/stash.js';
import { loadOperationState } from '../../main/git/operation-state.js';
import { deletedSide, loadConflict, parseStages, saveResolution, settleDeletion } from '../../main/git/conflicts.js';
import { buildInitArgv, initRepository, loadDefaultBranch } from '../../main/git/init.js';
import { loadUntrackedDiff, loadWorktree, loadWorktreeDiff } from '../../main/git/worktree.js';
import { movePlan, planDirectory } from '../../main/git/rebase.js';
import { isReloadKey } from '../../main/security.js';
import { PULL_COMMANDS, needsPullChoice, syncOutcome } from '../../renderer/src/app/sync-view.js';
import { moveClosedTab } from '../../renderer/src/app/closed-tabs.js';
import { moveCommitDraft, readCommitDraft, writeCommitDraft } from '../../renderer/src/features/worktree/commit-draft.js';
import { dropConflictDraft, pruneConflictDrafts, readConflictDraft, unsavedConflicts, writeConflictDraft } from '../../renderer/src/features/conflicts/conflict-drafts.js';
import { errorDetails } from '../../renderer/src/ui/error-details.js';

// The ways out of a dead end, on real repositories: a refused push and pull,
// conflicts with no operation behind them, modify/delete, a folder with no
// repository, a repository that moved, and a launch that does not wait for
// every repository.

process.env.GIT_CONFIG_NOSYSTEM = '1';
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-flows-')));
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'global.gitconfig');
await writeFile(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Twig Fixture\n\temail = twig@example.invalid\n[commit]\n\tgpgsign = false\n');
const log = new CommandLog(root); await log.load();
const git = async (cwd, ...args) => {
  // Twig's own Git only enters a bare repository when told to (`safe.bareRepository`).
  const argv = cwd.endsWith('.git') ? [`--git-dir=${cwd}`, ...args] : args;
  const result = await runGit({ cwd, log, argv });
  assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const write = (cwd, file, text) => writeFile(path.join(cwd, file), text);
const commit = async (cwd, file, text, message) => { await write(cwd, file, text); await git(cwd, 'add', '--', file); await git(cwd, 'commit', '-m', message); };
async function repository(name) {
  const cwd = path.join(root, name); await mkdir(cwd, { recursive: true });
  await git(cwd, 'init', '--initial-branch=main');
  await commit(cwd, 'a.txt', 'one\ntwo\nthree\n', 'first');
  return cwd;
}
const storage = () => {
  const values = new Map();
  return { getItem: key => (values.has(key) ? values.get(key) : null), setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), values };
};

try {
  // --- what Git says when it refuses a push ---------------------------------
  assert.equal(pushRefusal(' ! [rejected]        main -> main (fetch first)\nerror: failed to push'), 'behind');
  assert.equal(pushRefusal(' ! [rejected]        main -> main (non-fast-forward)'), 'non-fast-forward');
  assert.equal(pushRefusal(' ! [rejected]        main -> main (stale info)'), 'stale');
  assert.equal(pushRefusal(' ! [remote rejected] main -> main (pre-receive hook declined)'), 'remote');
  // Hints are translated and say anything; only the status of the ref counts.
  assert.equal(pushRefusal('hint: Updates were rejected\nfatal: unable to access'), null);
  assert.deepEqual(PULL_COMMANDS, { 'pull-merge': buildSyncArgv('pull-merge'), 'pull-rebase': buildSyncArgv('pull-rebase') });
  assert.deepEqual(buildSyncArgv('push-upstream', 'feat/x', 'gitlab'), ['push', '--set-upstream', 'gitlab', 'feat/x']);
  assert.throws(() => buildSyncArgv('push-upstream', 'main', '--upload-pack=x'), TypeError);
  assert.equal(needsPullChoice({ ahead: 1, behind: 2 }), true);
  assert.equal(needsPullChoice({ ahead: 0, behind: 2 }), false);

  const bare = path.join(root, 'server.git');
  const mine = await repository('mine');
  await git(root, 'init', '--bare', '--initial-branch=main', bare);
  await git(mine, 'remote', 'add', 'origin', bare);
  await git(mine, 'push', '--set-upstream', 'origin', 'main');
  const theirs = path.join(root, 'theirs');
  await git(root, 'clone', '--', bare, theirs);
  const options = { cwd: mine, log };

  // Somebody pushed and this clone has not fetched: Git says fetch first.
  await commit(theirs, 'b.txt', 'theirs\n', 'their work');
  await git(theirs, 'push');
  await commit(mine, 'c.txt', 'mine\n', 'my work');
  let result = await runSync({ ...options, mode: 'push', branch: 'main' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.refusal, { kind: 'behind' }, 'new commits on the remote are named as such');
  const behind = syncOutcome(result, { mode: 'push', branch: 'main', upstream: 'origin/main' });
  assert.ok(behind.failed && behind.text.includes('origin/main'));
  assert.deepEqual(behind.actions, ['pull-rebase', 'pull-merge'], 'lease is not offered over somebody else’s work');

  // After a fetch the same refusal reads non-fast-forward, and it still is not a rewrite.
  await git(mine, 'fetch');
  result = await runSync({ ...options, mode: 'push', branch: 'main' });
  assert.deepEqual(result.refusal, { kind: 'behind' }, 'an upstream tip this branch never held is not a rewrite');

  // A plain pull only fast-forwards; the answer says the branch moved on both sides.
  result = await runSync({ ...options, mode: 'pull', branch: 'main' });
  assert.deepEqual(result.refusal, { kind: 'diverged' });
  assert.deepEqual(syncOutcome(result, { mode: 'pull', branch: 'main', upstream: 'origin/main' }).actions, ['pull-rebase', 'pull-merge']);
  result = await runSync({ ...options, mode: 'pull-rebase', branch: 'main' });
  assert.equal(result.ok, true, result.reason);
  assert.equal((await runSync({ ...options, mode: 'push', branch: 'main' })).ok, true);

  // An amend of a pushed commit: this branch held the upstream tip and left it.
  await git(mine, 'commit', '--amend', '-m', 'my work, reworded');
  result = await runSync({ ...options, mode: 'push', branch: 'main' });
  assert.deepEqual(result.refusal, { kind: 'rewritten', lease: ['push', '--force-with-lease', 'origin', 'refs/heads/main:refs/heads/main'] });
  const rewritten = syncOutcome(result, { mode: 'push', branch: 'main', upstream: 'origin/main' });
  assert.equal(rewritten.actions[0], 'push-force', 'a rewritten branch is offered the lease');
  assert.ok(!result.refusal.lease.includes('--force'), 'and it is never a plain --force');
  assert.equal((await runSync({ ...options, mode: 'push-force', branch: 'main' })).ok, true);
  assert.equal(await git(bare, 'rev-parse', 'main'), await git(mine, 'rev-parse', 'HEAD'));

  // The lease refuses when the remote moved past what was fetched.
  await git(theirs, 'fetch');
  await git(theirs, 'reset', '--hard', 'origin/main');
  await commit(theirs, 'd.txt', 'more\n', 'more of theirs');
  await git(theirs, 'push');
  await git(mine, 'commit', '--amend', '-m', 'my work, again');
  result = await runSync({ ...options, mode: 'push-force', branch: 'main' });
  assert.deepEqual(result.refusal, { kind: 'stale' }, 'somebody’s push is not replaced by the lease');
  assert.notEqual(await git(bare, 'rev-parse', 'main'), await git(mine, 'rev-parse', 'HEAD'));

  // A pull that stops on a conflict is not a failure: the banner carries on.
  await git(mine, 'fetch');
  await git(mine, 'reset', '--hard', 'origin/main');
  await commit(mine, 'a.txt', 'mine\ntwo\nthree\n', 'edit a here');
  await git(theirs, 'pull', '--ff-only');
  await commit(theirs, 'a.txt', 'theirs\ntwo\nthree\n', 'edit a there');
  await git(theirs, 'push');
  result = await runSync({ ...options, mode: 'pull-merge', branch: 'main' });
  assert.deepEqual(result.refusal, { kind: 'stopped', operation: 'merge' });
  assert.equal(syncOutcome(result, { mode: 'pull-merge', branch: 'main', upstream: 'origin/main' }).failed, false);
  await git(mine, 'merge', '--abort');

  // A hook on the server says no: its reason is what the person needs.
  await git(mine, 'pull', '--no-rebase', '-X', 'ours');
  await write(bare, 'hooks/pre-receive', '#!/bin/sh\necho "branch is frozen" >&2\nexit 1\n');
  await git(bare, 'config', 'core.hooksPath', 'hooks');
  await chmod(path.join(bare, 'hooks/pre-receive'), 0o755);
  result = await runSync({ ...options, mode: 'push', branch: 'main' });
  assert.deepEqual(result.refusal, { kind: 'remote' });
  const remoteRefused = syncOutcome(result, { mode: 'push', branch: 'main', upstream: 'origin/main' });
  assert.ok(remoteRefused.failed && remoteRefused.detail.includes('branch is frozen'));

  // Publishing goes to the remote named, and only to one that is configured.
  const lonely = await repository('lonely');
  const other = path.join(root, 'gitlab.git');
  await git(root, 'init', '--bare', '--initial-branch=main', other);
  await git(lonely, 'remote', 'add', 'gitlab', other);
  await assert.rejects(runSync({ cwd: lonely, log, mode: 'push-upstream', branch: 'main', remote: 'nowhere' }), /not configured/);
  assert.equal((await runSync({ cwd: lonely, log, mode: 'push-upstream', branch: 'main', remote: 'gitlab' })).ok, true);
  assert.equal(await git(lonely, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'gitlab/main');

  // --- stash: an honest result, and a conflict that names itself --------------
  const shelf = await repository('shelf');
  assert.equal((await stashPush({ cwd: shelf, log, includeUntracked: true })).saved, false, 'nothing to save is not a stash');
  assert.equal((await loadStashes({ cwd: shelf, log })).length, 0);
  await write(shelf, 'a.txt', 'stashed\ntwo\nthree\n');
  assert.equal((await stashPush({ cwd: shelf, log, includeUntracked: true })).saved, true);
  await commit(shelf, 'a.txt', 'moved on\ntwo\nthree\n', 'moved on');
  await assert.rejects(stashPop({ cwd: shelf, log }), error => error.message === STASH_CONFLICT);
  assert.equal((await loadStashes({ cwd: shelf, log })).length, 1, 'Git keeps a stash that did not apply');
  const idle = await loadOperationState({ cwd: shelf, log });
  assert.equal(idle.kind, 'none', 'no operation is running: the status is what shows the conflict');
  assert.ok((await loadWorktree({ cwd: shelf, log })).unstaged.some(entry => entry.path === 'a.txt' && entry.status === 'U'));
  const opened = await loadConflict({ cwd: shelf, log, path: 'a.txt' });
  assert.equal(opened.deleted, null);
  assert.match(opened.merged, /<<<<<<</);
  await saveResolution({ cwd: shelf, log, path: 'a.txt', content: 'resolved\ntwo\nthree\n', mtimeMs: opened.mtimeMs, size: opened.size });
  assert.equal((await loadWorktree({ cwd: shelf, log })).unstaged.length, 0, 'saved: nothing is conflicted');
  assert.equal((await loadOperationState({ cwd: shelf, log })).kind, 'none');
  assert.equal((await loadStashes({ cwd: shelf, log })).length, 1, 'and the stash waits to be dropped');
  await git(shelf, 'reset', '--hard');
  await commit(shelf, 'a.txt', 'once more\ntwo\nthree\n', 'once more');
  const [entry] = await loadStashes({ cwd: shelf, log });
  const applied = await runStashAction({ cwd: shelf, log, action: 'apply', index: 0, expectedOid: entry.oid });
  assert.deepEqual(applied, { ok: false, message: STASH_CONFLICT }, 'the Stashes screen hears the same');
  await git(shelf, 'reset', '--hard');

  // --- modify/delete ----------------------------------------------------------
  const stageList = (...stages) => stages.map(stage => `100644 aa ${stage}\tf\0`).join('');
  assert.equal(deletedSide(parseStages(stageList(1, 2))), 'theirs');
  assert.equal(deletedSide(parseStages(stageList(1, 3))), 'ours');
  assert.equal(deletedSide(parseStages(stageList(1))), 'both');
  assert.equal(deletedSide(parseStages(stageList(1, 2, 3))), null);
  const split = await repository('split');
  await commit(split, 'gone.txt', 'base\n', 'add gone');
  await git(split, 'switch', '-c', 'feature');
  await git(split, 'rm', '-q', '--', 'gone.txt');
  await git(split, 'commit', '-m', 'delete it');
  await git(split, 'switch', 'main');
  await commit(split, 'gone.txt', 'changed here\n', 'change it');
  const stopMerge = async () => { const merged = await runGit({ cwd: split, log, argv: ['merge', '--no-edit', 'feature'] }); assert.notEqual(merged.code, 0); };
  await stopMerge();
  const deleted = await loadConflict({ cwd: split, log, path: 'gone.txt' });
  assert.equal(deleted.deleted, 'theirs');
  assert.equal(deleted.theirs, null);
  assert.equal(deleted.ours, 'changed here\n');
  await settleDeletion({ cwd: split, log, path: 'gone.txt', keep: false });
  assert.equal((await loadOperationState({ cwd: split, log })).resolved, true, 'deleting settles the conflict');
  await assert.rejects(stat(path.join(split, 'gone.txt')), { code: 'ENOENT' });
  await git(split, 'merge', '--abort');
  await stopMerge();
  await settleDeletion({ cwd: split, log, path: 'gone.txt', keep: true });
  assert.equal((await loadOperationState({ cwd: split, log })).resolved, true, 'keeping settles it too');
  assert.equal(await readFile(path.join(split, 'gone.txt'), 'utf8'), 'changed here\n');
  await git(split, 'merge', '--abort');
  await assert.rejects(settleDeletion({ cwd: split, log, path: 'a.txt', keep: true }), /no longer in conflict/);

  // --- an untracked file is read without touching the index --------------------
  const fresh = await repository('fresh');
  await write(fresh, 'new.txt', 'line one\nline two\n');
  const looked = await loadUntrackedDiff({ cwd: fresh, log, path: 'new.txt' });
  assert.equal((await loadWorktree({ cwd: fresh, log })).untracked.length, 1, 'still untracked after a look');
  assert.equal((await stashPush({ cwd: fresh, log, includeUntracked: true })).saved, true, 'and the stash takes it');
  await git(fresh, 'stash', 'pop');
  await git(fresh, 'add', '--intent-to-add', '--', 'new.txt');
  const tracked = await loadWorktreeDiff({ cwd: fresh, log, path: 'new.txt', staged: false });
  assert.deepEqual(tracked.hunks, looked.hunks, 'line numbers picked on the read apply once the file is tracked');

  // --- drafts -----------------------------------------------------------------
  const local = storage();
  assert.equal(readCommitDraft(local, '/r').message, '');
  writeCommitDraft(local, '/r', { message: 'subject\n\nbody', coAuthors: [{ name: 'A', email: 'a@e' }, { name: 5 }], bump: 'minor', amendOid: null, amendMessage: null });
  assert.deepEqual(readCommitDraft(local, '/r'), { message: 'subject\n\nbody', coAuthors: [{ name: 'A', email: 'a@e' }], bump: 'minor', amendOid: null, amendMessage: null });
  assert.equal(readCommitDraft(local, '/other').message, '', 'a draft belongs to its repository');
  moveCommitDraft(local, '/r', '/r');
  assert.equal(readCommitDraft(local, '/r').bump, 'minor', 'a folder that came back keeps its draft');
  moveCommitDraft(local, '/r', '/moved');
  assert.equal(readCommitDraft(local, '/moved').bump, 'minor');
  assert.equal(readCommitDraft(local, '/r').message, '');
  writeCommitDraft(local, '/moved', { message: '  ', coAuthors: [], bump: null, amendOid: null, amendMessage: null });
  assert.equal(local.values.size, 0, 'a finished commit leaves nothing behind');
  local.setItem('twig:commit-draft:/bad', '{broken');
  assert.equal(readCommitDraft(local, '/bad').message, '');
  assert.doesNotThrow(() => writeCommitDraft({ setItem() { throw new Error('full'); }, removeItem() { throw new Error('full'); } }, '/r', { message: 'x', coAuthors: [] }));

  writeConflictDraft('/r', 'f.txt', { text: 'mine', past: ['a'], future: [], mtimeMs: 1, size: 2 });
  writeConflictDraft('/r', 'g.txt', { text: 'too', past: [], future: [], mtimeMs: 1, size: 2 });
  writeConflictDraft('/other', 'f.txt', { text: 'elsewhere', past: [], future: [], mtimeMs: 1, size: 2 });
  assert.equal(readConflictDraft('/r', 'f.txt').text, 'mine');
  assert.deepEqual([...unsavedConflicts('/r')].sort(), ['f.txt', 'g.txt']);
  pruneConflictDrafts('/r', ['g.txt']);
  assert.equal(readConflictDraft('/r', 'f.txt'), null, 'a file no longer in conflict has nothing to keep');
  assert.equal(readConflictDraft('/other', 'f.txt').text, 'elsewhere');
  dropConflictDraft('/r', 'g.txt');
  assert.equal(unsavedConflicts('/r').size, 0);

  // --- the keys that used to reload the page ----------------------------------
  const press = input => ({ type: 'keyDown', key: 'r', meta: false, control: false, shift: false, alt: false, isAutoRepeat: false, ...input });
  assert.equal(isReloadKey(press({ meta: true }), 'darwin'), true);
  assert.equal(isReloadKey(press({ control: true }), 'darwin'), false);
  assert.equal(isReloadKey(press({ control: true }), 'win32'), true);
  assert.equal(isReloadKey(press({ meta: true, shift: true }), 'darwin'), false);
  assert.equal(isReloadKey(press({ meta: true, type: 'keyUp' }), 'darwin'), false);
  assert.equal(isReloadKey(press({ meta: true, key: 'k' }), 'darwin'), false);

  assert.match(errorDetails(new TypeError('boom'), '\n  at Panel'), /^TypeError: boom[\s\S]*at Panel$/);
  assert.equal(errorDetails('plain'), 'Error: plain');

  // --- a folder with no repository --------------------------------------------
  const userData = path.join(root, 'user-data'); await mkdir(userData);
  const service = createRepositoryService({ log, store: new RepositoryStore(userData) });
  await service.load();
  const empty = path.join(root, 'new project'); await mkdir(empty);
  assert.equal(await service.inspect(empty), 'none');
  assert.equal(await service.inspect(bare), 'bare');
  assert.equal(await service.inspect(mine), 'repository');
  await assert.rejects(service.add(bare), /bare repository/, 'a bare repository is told apart from no repository');
  await assert.rejects(service.add(empty), /Choose a folder/);
  assert.deepEqual(buildInitArgv('trunk'), ['init', '--initial-branch=trunk']);
  assert.throws(() => buildInitArgv('--bare'), TypeError);
  assert.equal(await loadDefaultBranch({ cwd: empty, log }), 'main');
  await writeFile(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Twig Fixture\n\temail = twig@example.invalid\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = trunk\n');
  assert.equal(await loadDefaultBranch({ cwd: empty, log }), 'trunk');
  await initRepository({ cwd: empty, log, branch: 'trunk' });
  assert.equal(await git(empty, 'symbolic-ref', '--short', 'HEAD'), 'trunk');
  assert.equal(await service.inspect(empty), 'repository');

  // --- a launch reads the window's repository first ---------------------------
  const launchData = path.join(root, 'launch'); await mkdir(launchData);
  const names = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
  const repos = await Promise.all(names.map(repository));
  const reposStore = new RepositoryStore(launchData);
  await reposStore.load();
  await reposStore.save(repos.map(item => ({ id: item, path: item, name: path.basename(item) })), repos[3]);
  const sandbox = { dir: path.join(launchData, 'demo'), remoteDir: path.join(launchData, 'demo.git'), markerFile: path.join(launchData, 'demo.json') };
  const launch = createRepositoryService({ log, store: new RepositoryStore(launchData), sandbox });
  await launch.loadStored();
  assert.ok(launch.snapshot().repositories.every(item => item.available === undefined), 'nothing is called missing before it is read');
  const updates = [];
  launch.onUpdate(update => updates.push(update));
  const before = log.list().length;
  const { first, settled } = launch.start();
  const opening = await first;
  const read = opening.repositories.filter(item => item.available === true).map(item => item.id);
  assert.deepEqual(read, [repos[3]], 'the window waits for its own tab only');
  assert.equal(opening.repositories.find(item => item.sandbox).available, undefined);
  const done = await settled;
  assert.ok(done.repositories.every(item => item.available === true));
  assert.ok(updates.length >= 2, 'the rest arrives as it is read');
  assert.ok(log.list().slice(before).some(item => item.operation?.startsWith('Seed demo workspace')), 'the demo is seeded behind the window');
  const again = createRepositoryService({ log, store: new RepositoryStore(launchData), sandbox });
  assert.equal((await again.load()).repositories.length, 9, 'load still reads everything in one step');

  // A demo that cannot be seeded costs its tab, not the window.
  const brokenData = path.join(root, 'broken'); await mkdir(brokenData);
  await writeFile(path.join(brokenData, 'in-the-way'), 'a file where a folder is needed');
  const broken = createRepositoryService({ log, store: new RepositoryStore(brokenData),
    sandbox: { dir: path.join(brokenData, 'in-the-way', 'demo'), remoteDir: path.join(brokenData, 'in-the-way', 'r.git'), markerFile: path.join(brokenData, 'm.json') } });
  const seeded = await broken.load();
  const demo = seeded.repositories.find(item => item.sandbox);
  assert.equal(demo.available, false);
  assert.ok(demo.seedError, 'and the tab can say why');

  // --- a repository that moved -------------------------------------------------
  const moveData = path.join(root, 'moves'); await mkdir(moveData);
  const marks = new MarksStore(moveData); await marks.load();
  const automations = new AutomationsStore(moveData); await automations.load();
  const runs = new AutomationRunsStore(moveData); await runs.load();
  const undo = new UndoService({ directory: moveData, log }); await undo.load();
  const plan = { rekey: (from, to) => movePlan({ stateDir: moveData, from, to }) };
  const old = await repository('old place');
  const oid = await git(old, 'rev-parse', 'HEAD');
  const moved = createRepositoryService({ log, store: new RepositoryStore(moveData), marks, undo, movers: [marks, automations, runs, undo, plan] });
  await moved.load();
  await moved.add(old);
  await marks.set(old, oid, { color: 'red', note: 'keep' });
  await automations.setTrust(old, { digest: 'abc', approvedCommands: ['npm test'], enabledRepoPipelineIds: ['p1'] });
  await automations.saveConfig(old, { pipelines: [], settings: {} });
  await runs.append(old, { id: 'run-1', steps: [] });
  await undo.perform(old, 'refs:create-branch', ['side', oid, false], () => runGit({ cwd: old, log, argv: ['branch', '--', 'side', oid] }).then(() => ({ ok: true })));
  await mkdir(planDirectory(moveData, old), { recursive: true });
  const place = path.join(root, 'new place');
  await rename(old, place);
  await moved.select(old);
  assert.equal(moved.snapshot().repositories.find(item => item.id === old).available, false);
  const other2 = await repository('someone else');
  await moved.add(other2);
  await assert.rejects(moved.relocate(old, other2), /already connected/, 'two entries never point at one folder');
  await assert.rejects(moved.relocate(old, bare), /bare repository/);
  await assert.rejects(moved.relocate(old, root), /Choose a folder/);
  await assert.rejects(moved.relocate('/not/connected', place), /Unknown repository/);

  const outcome = await moved.relocate(old, place);
  assert.equal(outcome.from, old);
  assert.equal(outcome.to, place);
  const entryNow = outcome.workspace.repositories.find(item => item.id === place);
  assert.equal(entryNow.available, true);
  assert.equal(entryNow.name, 'new place');
  assert.equal(outcome.workspace.repositories.some(item => item.id === old), false, 'no second entry stays behind');
  assert.equal(marks.list(place)[oid].note, 'keep');
  assert.deepEqual(marks.list(old), {});
  assert.deepEqual(automations.trust(place).approvedCommands, ['npm test']);
  assert.equal(automations.trust(old).digest, null);
  assert.equal(runs.list(place).length, 1);
  assert.equal(runs.list(old).length, 0);
  assert.equal((await undo.inspect(place)).undo, true, 'the Undo chain goes on in the new place');
  await assert.rejects(stat(planDirectory(moveData, old)), { code: 'ENOENT' });
  await stat(planDirectory(moveData, place));
  const persisted = new RepositoryStore(moveData);
  assert.ok((await persisted.load()).repositories.some(item => item.id === place), 'the move survives a restart');
  assert.ok(moveClosedTab(new Set(['/a']), '/a', '/b').has('/b'));
  assert.equal(moveClosedTab(new Set(['/a']), '/a', '/b').has('/a'), false);

  // A store that refuses puts the others back, and the entry stays where it was.
  const third = path.join(root, 'third place');
  await rename(place, third);
  const refusing = createRepositoryService({ log, store: new RepositoryStore(moveData), marks, movers: [marks, { rekey: async () => { throw new Error('disk full'); } }] });
  await refusing.load();
  await assert.rejects(refusing.relocate(place, third), /disk full/);
  assert.equal(marks.list(place)[oid].note, 'keep', 'the marks went back');
  assert.ok(refusing.snapshot().repositories.some(item => item.id === place));

  console.log('Flows checks passed: refused push and pull with their way out, lease only over a rewrite, publish to a named remote, honest stash, conflicts with no operation, modify/delete, untracked without the index, drafts, Refresh key, git init, bare, launch order, failed seed, a repository that moved.');
} finally {
  await rm(root, { recursive: true, force: true });
}
