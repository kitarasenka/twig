import assert from 'node:assert/strict';
import {
  buildCherryPickArgv, buildMergeArgv, buildResetArgv, buildRevertArgv, buildSequencerArgv,
  RESET_MODES, sequencerSteps, validateRevision
} from '../../main/git/history-ops.js';
import {
  buildCheckoutBranchArgv, buildCheckoutCommitArgv, buildCheckoutNewBranchArgv, buildCreateBranchArgv,
  buildCreateTagArgv, buildDeleteBranchArgv, buildDeleteTagArgv, buildRenameBranchArgv, buildUpstreamArgv,
  validateRefName
} from '../../main/git/refs-ops.js';
import { buildPushRefArgv } from '../../main/git/sync.js';
import { pushRefCommand, splitRemoteRef } from '../../renderer/src/features/refs/remote-ref.js';
import { buildEditorEnv, buildMessageMap, buildRebaseArgv, buildTodo, planDirectory } from '../../main/git/rebase.js';
import { buildRebaseTodoArgv } from '../../main/git/history.js';
import { buildMarkResolvedArgv, buildStageContentArgv, buildTakeSideArgv } from '../../main/git/conflicts.js';
import { buildRewordArgv } from '../../main/git/commit-ops.js';
import { buildRewordPlan } from '../../renderer/src/features/ops/reword-plan.js';
import { buildCommitMenu } from '../../renderer/src/features/ops/commit-menu.js';

const A = '82df62445b05a04be53291bb36b5db80e46dad77';
const B = 'ebb6e9d3dec115ba8b429d3b143db9d27777a083';
const C = '9d8a538c2683a0ed898778e9c139f019b57471e2';
const SHA256 = 'a1b2c3'.repeat(10) + 'a1b2';
assert.equal(SHA256.length, 64);

// --- ref names -------------------------------------------------------------
// git-check-ref-format(1), enforced without running Git.
for (const good of ['main', 'feature/login', 'release-1.2', 'user/x.y', SHA256]) {
  assert.equal(validateRefName(good), good, good);
}
for (const bad of ['', ' ', 'has space', 'a..b', 'tip~1', 'q^', 'a:b', 'wild*', 'br[x]', 'back\\slash',
  '.hidden', 'a/.hidden', 'ends.', 'thing.lock', 'a//b', '/leading', 'trailing/', '@', 'ref@{0}', 'nul\0byte']) {
  assert.throws(() => validateRefName(bad), TypeError, `should reject ${JSON.stringify(bad)}`);
}
// A name that looks like a flag is still only a name, and every argv puts it
// after `--` so Git can never read it as an option.
assert.deepEqual(buildCreateBranchArgv('--force', A), ['branch', '--', '--force', A]);
assert.deepEqual(buildDeleteBranchArgv('-D', false), ['branch', '-d', '--', '-D']);
assert.deepEqual(buildCheckoutBranchArgv('main'), ['checkout', 'main', '--']);
assert.deepEqual(buildCheckoutCommitArgv(A), ['checkout', '--detach', A, '--']);
assert.deepEqual(buildCheckoutNewBranchArgv('topic', A), ['checkout', '-b', 'topic', A, '--']);
assert.deepEqual(buildCreateTagArgv('v1', A, false), ['tag', '--', 'v1', A]);
assert.deepEqual(buildCreateTagArgv('v1', A, true), ['tag', '--annotate', '--file=-', '--', 'v1', A]);
assert.throws(() => buildCreateBranchArgv('ok', 'not-an-oid'), TypeError);

// --- merge, cherry-pick, revert, reset --------------------------------------
assert.deepEqual(buildMergeArgv('feature'), ['merge', '--no-edit', 'feature']);
assert.deepEqual(buildMergeArgv('origin/feature', { noFf: true }), ['merge', '--no-edit', '--no-ff', 'origin/feature']);
assert.equal(validateRevision(A), A);
assert.throws(() => buildMergeArgv('bad name'), TypeError);
assert.deepEqual(buildCherryPickArgv(A), ['cherry-pick', A]);
assert.deepEqual(buildRevertArgv(A), ['revert', '--no-edit', A]);
assert.deepEqual(buildRevertArgv(A, 1), ['revert', '--no-edit', '--mainline', '1', A]);
for (const bad of [0, -1, 1.5, 17]) assert.throws(() => buildRevertArgv(A, bad), TypeError, `mainline ${bad}`);
for (const mode of RESET_MODES) assert.deepEqual(buildResetArgv(mode, A), ['reset', `--${mode}`, A]);
assert.throws(() => buildResetArgv('keep', A), TypeError);
assert.throws(() => buildResetArgv('merge', A), TypeError);

// A merge cannot skip a commit: it only has the one. Offering `--skip` would
// be a lie, so the builder refuses it rather than letting Git error later.
assert.deepEqual(sequencerSteps('merge'), ['continue', 'abort']);
assert.throws(() => buildSequencerArgv('merge', 'skip'), TypeError);
assert.deepEqual(buildSequencerArgv('rebase', 'abort'), ['rebase', '--abort']);
assert.deepEqual(buildSequencerArgv('cherry-pick', 'skip'), ['cherry-pick', '--skip']);
assert.throws(() => buildSequencerArgv('push', 'continue'), TypeError);
assert.throws(() => buildSequencerArgv('rebase', 'quit'), TypeError);

// --- rebase plan ------------------------------------------------------------
assert.equal(buildTodo([{ action: 'pick', oid: A }, { action: 'drop', oid: B }]), `pick ${A}\ndrop ${B}\n`);
assert.deepEqual(buildMessageMap([
  { action: 'reword', oid: A, message: 'new subject' },
  { action: 'squash', oid: B },
  { action: 'pick', oid: C }
]), { [A]: 'new subject' });
// Only reword supplies a message: a squash keeps Git's own combined default,
// which is what leaving its editor file untouched produces.
assert.deepEqual(buildMessageMap([{ action: 'pick', oid: A }, { action: 'squash', oid: B }]), {});
assert.throws(() => buildTodo([]), TypeError);
assert.throws(() => buildTodo([{ action: 'squash', oid: A }]), TypeError, 'first commit cannot squash');
assert.throws(() => buildTodo([{ action: 'drop', oid: A }, { action: 'fixup', oid: B }]), TypeError, 'first kept commit cannot fix up');
assert.throws(() => buildTodo([{ action: 'drop', oid: A }]), TypeError, 'a plan must keep something');
assert.throws(() => buildTodo([{ action: 'pick', oid: A }, { action: 'pick', oid: A }]), TypeError, 'no duplicates');
assert.throws(() => buildTodo([{ action: 'reword', oid: A, message: '  ' }]), TypeError, 'reword needs a message');
assert.throws(() => buildTodo([{ action: 'exec', oid: A }]), TypeError, 'only the six documented actions');
assert.deepEqual(buildRebaseArgv({ oid: A }), ['rebase', A]);
assert.deepEqual(buildRebaseArgv({ oid: A, interactive: true }), ['rebase', '--interactive', A]);
assert.deepEqual(buildRebaseTodoArgv(A), ['log', '--reverse', '--topo-order', '--no-merges', '-z',
  '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b', `${A}..HEAD`]);

// The plan never lands inside the repository being rebased.
const plan = planDirectory('/state', '/repos/thing');
assert.ok(plan.startsWith('/state/rebase/'), plan);
assert.notEqual(planDirectory('/state', '/repos/other'), plan);

// A non-interactive call still installs the message editor, because
// `--continue` after a conflict opens one whether the rebase was interactive
// or not; only an interactive start installs the sequence editor.
const plainEnv = buildEditorEnv({ gitDir: '/repo/.git' });
assert.ok(plainEnv.GIT_EDITOR.includes('message-editor.cjs'));
assert.equal(plainEnv.TWIG_GIT_DIR, '/repo/.git');
assert.equal(plainEnv.GIT_SEQUENCE_EDITOR, undefined);
const planEnv = buildEditorEnv({ gitDir: '/repo/.git', todoFile: '/state/todo', messagesFile: '/state/m.json' });
assert.ok(planEnv.GIT_SEQUENCE_EDITOR.includes('sequence-editor.cjs'));
assert.equal(planEnv.TWIG_REBASE_TODO, '/state/todo');
assert.equal(planEnv.TWIG_REBASE_MESSAGES, '/state/m.json');
// Both editor commands are shell strings; the paths must stay quoted or a
// space in the install path would split them into two arguments.
for (const command of [planEnv.GIT_EDITOR, planEnv.GIT_SEQUENCE_EDITOR]) {
  assert.equal((command.match(/"/g) || []).length, 4, command);
}

// --- conflict argv ----------------------------------------------------------
assert.deepEqual(buildStageContentArgv(2, 'src/a.js'), ['show', ':2:src/a.js']);
assert.deepEqual(buildTakeSideArgv('theirs', 'a b.txt'), ['checkout', '--theirs', '--', ':(literal)a b.txt']);
assert.deepEqual(buildMarkResolvedArgv('-weird.txt'), ['add', '--', ':(literal)-weird.txt']);
assert.throws(() => buildTakeSideArgv('mine', 'a.txt'), TypeError);
for (const bad of ['../escape', '/etc/passwd', 'a/../../b', 'nul\0']) {
  assert.throws(() => buildMarkResolvedArgv(bad), TypeError, bad);
}

// --- context menu applicability ---------------------------------------------
const commit = { oid: A, subject: 'a change', body: '', parents: [B] };
const keysOf = menu => menu.filter(item => !item.separator).map(item => item.key);
// Menu.jsx disables any item that carries a reason, so the check reads it the same way.
const enabledOf = menu => menu.filter(item => !item.separator && !item.reason).map(item => item.key);
const handlers = Object.fromEntries(['createBranch', 'createTag', 'checkoutBranch', 'checkoutCommit', 'merge',
  'cherryPick', 'revert', 'rebase', 'interactiveRebase', 'reword', 'reset', 'copy', 'mark', 'removeMark'].map(name => [name, () => {}]));

// No branch points at this commit: Merge is shown but disabled, with the
// reason, because its absence would read as a missing feature.
{
  const menu = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, handlers });
  assert.ok(keysOf(menu).includes('merge-none'));
  assert.ok(!enabledOf(menu).includes('merge-none'));
  assert.ok(enabledOf(menu).includes('cherry-pick'));
  assert.ok(enabledOf(menu).includes('reset-hard'));
}
// A branch here offers merge with and without fast-forward, and a checkout of
// that branch — but never a merge of the branch that is already checked out.
{
  const refs = [{ type: 'local', name: 'feature', fullName: 'refs/heads/feature' },
    { type: 'local', name: 'main', fullName: 'refs/heads/main' }];
  const keys = keysOf(buildCommitMenu({ commit, refs, head: { branch: 'main', oid: C }, handlers }));
  assert.ok(keys.includes('merge-refs/heads/feature'));
  assert.ok(keys.includes('merge-noff-refs/heads/feature'));
  assert.ok(keys.includes('checkout-refs/heads/feature'));
  assert.ok(!keys.includes('merge-refs/heads/main'), 'the current branch is not offered to itself');
  assert.ok(!keys.includes('checkout-refs/heads/main'));
}
// On the commit the branch already sits on, rebasing onto it is meaningless.
{
  const menu = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: A }, handlers });
  assert.ok(!enabledOf(menu).includes('rebase'));
  assert.ok(!enabledOf(menu).includes('rebase-i'));
  assert.ok(!enabledOf(menu).includes('cherry-pick'));
}
// Mid-operation nothing may run, but copying is always safe and the reason is
// spelled out rather than left to be inferred from a shrunken menu.
{
  const menu = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, operation: { kind: 'rebase' }, handlers });
  assert.deepEqual(enabledOf(menu), ['mark', 'copy-sha', 'copy-message']);
  assert.match(menu.find(item => item.key === 'reset-hard').reason, /rebase/);
}
// Local marks are userData metadata, not Git: the item is always enabled, and
// "Remove mark" only shows once a mark exists.
{
  const clean = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, handlers });
  assert.equal(keysOf(clean).includes('unmark'), false);
  assert.equal(clean.find(item => item.key === 'mark').text, 'Mark this commit…');
  const marked = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, mark: { color: 'red', note: 'x' }, operation: { kind: 'rebase' }, handlers });
  assert.deepEqual(enabledOf(marked).filter(key => key.startsWith('mark') || key === 'unmark'), ['mark', 'unmark']);
  assert.equal(marked.find(item => item.key === 'mark').text, 'Edit mark and note…');
}
// A merge commit is labelled as one, so `--mainline` is not a surprise.
{
  const merge = { oid: A, subject: 'merge', body: '', parents: [B, C] };
  const menu = buildCommitMenu({ commit: merge, refs: [], head: { branch: 'main', oid: C }, handlers });
  assert.equal(menu.find(item => item.key === 'revert').hint, 'merge commit');
}

// --- branch and tag management ----------------------------------------------
assert.deepEqual(buildRenameBranchArgv('old', 'new'), ['branch', '-m', '--', 'old', 'new']);
assert.deepEqual(buildUpstreamArgv('feature', 'origin/feature'),
  ['branch', '--set-upstream-to=origin/feature', '--', 'feature']);
assert.deepEqual(buildUpstreamArgv('feature', null), ['branch', '--unset-upstream', '--', 'feature']);
assert.deepEqual(buildDeleteTagArgv('v1.0.0'), ['tag', '-d', '--', 'v1.0.0']);
assert.deepEqual(buildDeleteBranchArgv('-D', false), ['branch', '-d', '--', '-D'],
  'a branch named like a flag stays behind the double dash');
for (const bad of ['has space', 'a..b', '', null]) {
  assert.throws(() => buildRenameBranchArgv('main', bad), TypeError, `rename to ${String(bad)}`);
  assert.throws(() => buildDeleteTagArgv(bad), TypeError, `tag ${String(bad)}`);
}
// `null` is the one upstream that is not a name: it means "stop tracking".
for (const bad of ['has space', 'a..b', '', '@']) {
  assert.throws(() => buildUpstreamArgv('main', bad), TypeError, `upstream ${String(bad)}`);
  assert.throws(() => buildUpstreamArgv(bad, 'origin/main'), TypeError, `branch ${String(bad)}`);
}

// --- publishing one ref -----------------------------------------------------
assert.deepEqual(buildPushRefArgv({ remote: 'origin', ref: 'refs/tags/v1' }),
  ['push', '--progress', 'origin', '--', 'refs/tags/v1']);
assert.deepEqual(buildPushRefArgv({ remote: 'origin', ref: 'refs/heads/feature', remove: true }),
  ['push', '--progress', '--delete', 'origin', '--', 'refs/heads/feature']);
for (const bad of ['feature', 'refs/remotes/origin/feature', 'refs/heads/', '--delete', '', null]) {
  assert.throws(() => buildPushRefArgv({ remote: 'origin', ref: bad }), TypeError, `ref ${String(bad)}`);
}
for (const bad of ['-origin', 'has space', '', null]) {
  assert.throws(() => buildPushRefArgv({ remote: bad, ref: 'refs/tags/v1' }), TypeError, `remote ${String(bad)}`);
}
// The confirmation dialog prints the command from the renderer's own copy, so
// the two must not drift: whatever it shows is what main will run.
for (const options of [{ remote: 'origin', ref: 'refs/tags/v1' },
  { remote: 'upstream', ref: 'refs/heads/feature/x', remove: true }]) {
  assert.deepEqual(pushRefCommand(options), buildPushRefArgv(options));
}

// A remote name may contain a slash, so the split is decided by the configured
// remotes and the longest match wins — never by the first slash.
assert.deepEqual(splitRemoteRef('refs/remotes/origin/feature/x', ['origin']),
  { remote: 'origin', branch: 'feature/x', ref: 'refs/heads/feature/x' });
assert.deepEqual(splitRemoteRef('refs/remotes/team/sub/feature', ['team', 'team/sub']),
  { remote: 'team/sub', branch: 'feature', ref: 'refs/heads/feature' });
assert.equal(splitRemoteRef('refs/remotes/gone/feature', ['origin']), null, 'an unconfigured remote resolves to nothing');
assert.equal(splitRemoteRef('refs/heads/main', ['origin']), null);
assert.equal(splitRemoteRef('refs/remotes/origin/', ['origin']), null, 'a remote with no branch is not a ref');

// --- bisect in the context menu ---------------------------------------------
{
  const idle = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, handlers });
  assert.ok(enabledOf(idle).includes('bisect-start'));
  assert.ok(!keysOf(idle).includes('bisect-bad'), 'nothing can be marked before a bisect starts');

  const dirty = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, dirty: true, handlers });
  assert.ok(!enabledOf(dirty).includes('bisect-start'), 'bisect checks commits out, so it needs a clean tree');
  assert.match(dirty.find(item => item.key === 'bisect-start').reason, /stash/);

  const running = buildCommitMenu({
    commit, refs: [], head: { branch: 'main', oid: C }, handlers,
    bisect: { active: true, done: false, terms: { bad: 'broken', good: 'works' }, skipped: [] }
  });
  assert.ok(enabledOf(running).includes('bisect-bad'));
  assert.ok(enabledOf(running).includes('bisect-reset'));
  assert.ok(!keysOf(running).includes('bisect-start'));
  assert.match(running.find(item => item.key === 'bisect-bad').text, /broken/, 'the repository\'s own terms are used');

  const finished = buildCommitMenu({
    commit, refs: [], head: { branch: 'main', oid: C }, handlers,
    bisect: { active: true, done: true, terms: { bad: 'bad', good: 'good' }, skipped: [] }
  });
  assert.ok(!keysOf(finished).includes('bisect-bad'), 'a finished search has nothing left to mark');
  assert.ok(enabledOf(finished).includes('bisect-reset'));
}

// --- rewording a commit ------------------------------------------------------
// `--only` with no paths is the whole point: without it `--amend` would fold
// whatever is staged into the commit whose message was being fixed.
assert.deepEqual(buildRewordArgv(), ['commit', '--amend', '--only', '--file=-', '--cleanup=strip']);

// An older commit is reworded by replaying the range: exactly one line is a
// reword, every other commit is picked, and the order Git executes is kept.
{
  const commits = [{ oid: A }, { oid: B }, { oid: C }];
  assert.deepEqual(buildRewordPlan(commits, B, 'a better subject'), [
    { action: 'pick', oid: A },
    { action: 'reword', oid: B, message: 'a better subject' },
    { action: 'pick', oid: C }
  ]);
  assert.deepEqual(buildTodo(buildRewordPlan(commits, B, 'x')), `pick ${A}\nreword ${B}\npick ${C}\n`);
  assert.deepEqual(buildMessageMap(buildRewordPlan(commits, B, 'x')), { [B]: 'x' });
  assert.throws(() => buildRewordPlan(commits, SHA256, 'x'), /not among/, 'a commit outside the range is refused');
  assert.throws(() => buildRewordPlan(commits, B, '  '), /needs a message/);
  assert.throws(() => buildRewordPlan([], B, 'x'), /no commits/);
}

// The tip is reworded by `--amend` and needs nothing else; an older commit
// inherits every condition a rebase has, and each refusal says which one.
{
  const tip = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: A }, dirty: true, handlers });
  assert.ok(enabledOf(tip).includes('reword'), 'amending the tip does not care about the working tree');

  const older = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, handlers });
  assert.ok(enabledOf(older).includes('reword'));
  assert.match(older.find(item => item.key === 'reword').hint, /replays/);

  const dirtyOlder = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: C }, dirty: true, handlers });
  assert.match(dirtyOlder.find(item => item.key === 'reword').reason, /stash/);

  const root = buildCommitMenu({ commit: { oid: A, subject: 'root', body: '', parents: [] }, refs: [], head: { branch: 'main', oid: C }, handlers });
  assert.match(root.find(item => item.key === 'reword').reason, /starts the history/);

  const mergeCommit = buildCommitMenu({ commit: { oid: A, subject: 'merge', body: '', parents: [B, C] }, refs: [], head: { branch: 'main', oid: C }, handlers });
  assert.match(mergeCommit.find(item => item.key === 'reword').reason, /merge commit/);

  const busy = buildCommitMenu({ commit, refs: [], head: { branch: 'main', oid: A }, operation: { kind: 'merge' }, handlers });
  assert.ok(!enabledOf(busy).includes('reword'), 'mid-merge HEAD is not the commit on screen');
}

console.log('history-ops: all checks passed');
