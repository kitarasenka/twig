import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { applyPatch, buildApplyArgv, buildFormatPatchArgv, checkPatch, exportName, exportPatches, inspectPatch, slug, validateExport } from '../../main/git/patches.js';
import { loadOperationState, resolveGitDir } from '../../main/git/operation-state.js';
import { sequencer, sequencerSteps } from '../../main/git/history-ops.js';
import { buildUndoPlan, inverseReason } from '../../main/git/undo-plan.js';
import { createTokenRegistry } from '../../main/token-registry.js';
import { exportOrder, patchCommand, patchCommandText, patchConsequence } from '../../renderer/src/features/ops/patch-view.js';
import { buildCommitMenu, buildMultiCommitMenu } from '../../renderer/src/features/ops/commit-menu.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';

const A = 'a'.repeat(40); const B = 'b'.repeat(40);

// --- names, argv and words --------------------------------------------------------------------
assert.equal(slug('Fix the login form (again)!'), 'fix-the-login-form-again');
assert.equal(slug('🌱'), 'patch');
assert.equal(exportName([A], 'Add README'), 'aaaaaaa-add-readme.patch');
assert.equal(exportName([A, B], ''), '2-commits-from-aaaaaaa.patch');
assert.throws(() => validateExport([]), TypeError);
assert.throws(() => validateExport([A, A]), TypeError);
assert.throws(() => validateExport(['--output=/etc/passwd']), TypeError);
assert.deepEqual(buildFormatPatchArgv(A, 2, '/tmp/x'), ['format-patch', '--output-directory', '/tmp/x', '--start-number=2', '-1', A]);
assert.throws(() => buildFormatPatchArgv(A, 1, 'relative'), TypeError);
assert.deepEqual(buildApplyArgv({ kind: 'mbox', file: '/p/a b.patch' }), ['am', '--3way', '--', '/p/a b.patch']);
assert.deepEqual(buildApplyArgv({ kind: 'diff', file: '/p/x.diff', index: true }), ['apply', '--index', '--', '/p/x.diff']);
assert.throws(() => buildApplyArgv({ kind: 'diff', file: 'x.diff' }), TypeError, 'only a path from the dialog, which is absolute');
for (const [kind, index] of [['mbox', false], ['diff', false], ['diff', true]]) {
  assert.deepEqual(patchCommand({ kind, name: 'x.patch' }, index), buildApplyArgv({ kind, file: '/dir/x.patch', index }).map(arg => (arg === '/dir/x.patch' ? 'x.patch' : arg)),
    'the dialog shows the command main runs, with the file name for the path');
}
assert.equal(patchCommandText({ kind: 'mbox', name: 'my fix.patch' }), 'am --3way -- "my fix.patch"');
assert.match(patchConsequence({ kind: 'mbox', commits: ['a', 'b'] }, 'main'), /2 new commits are made on main/);
assert.match(patchConsequence({ kind: 'diff' }, 'main', true), /and staged; no commit/);
assert.deepEqual(exportOrder([{ oid: B }, { oid: A }]), [A, B], 'the graph lists newest first; the file is oldest first');
assert.equal(isUserCommand(`Export ${A.slice(0, 7)} as a patch`), true);
assert.equal(isUserCommand('Read whether the patch applies'), false);
assert.deepEqual(sequencerSteps('am'), ['continue', 'skip', 'abort']);

const handlers = new Proxy({}, { get: () => () => {} });
const single = buildCommitMenu({ commit: { oid: A, parents: [B], subject: 's', body: '' }, handlers });
assert.ok(single.some(item => item.key === 'export-patch' && !item.reason));
assert.match(buildCommitMenu({ commit: { oid: A, parents: [B, B], subject: 's', body: '' }, handlers }).find(item => item.key === 'export-patch').reason, /merge commit/);
assert.ok(buildMultiCommitMenu({ commits: [{ oid: A, parents: [B] }, { oid: B, parents: [] }], handlers }).some(item => item.key === 'export-patches'));

// --- the token registry ---------------------------------------------------------------------
{
  let clock = 0;
  const registry = createTokenRegistry({ now: () => clock, lifetime: 1000 });
  const token = registry.add('/repo', { file: '/p/x.patch', kind: 'mbox' });
  assert.throws(() => registry.take('/other', token), TypeError, 'a token belongs to one repository');
  assert.equal(registry.take('/repo', token).file, '/p/x.patch');
  assert.throws(() => registry.take('/repo', token), TypeError, 'and is spent on use');
  const late = registry.add('/repo', { file: '/p/y.patch', kind: 'diff' });
  clock = 2000;
  assert.throws(() => registry.take('/repo', late), /again/, 'and expires');
  assert.throws(() => registry.take('/repo', '/p/y.patch'), TypeError, 'a path is not a token');
}

// --- real Git ----------------------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-patches-'));
try {
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const setup = async cwd => {
    await runGit({ cwd: root, log, argv: ['init', '--initial-branch=main', cwd] });
    for (const [key, value] of [['user.name', 'Twig Check'], ['user.email', 'check@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await runGit({ cwd, log, argv: ['config', key, value] });
  };
  const git = async (cwd, argv) => { const result = await runGit({ cwd, log, argv }); assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };
  const source = path.join(root, 'source'); const target = path.join(root, 'target');
  await setup(source); await setup(target);
  for (const cwd of [source, target]) { await writeFile(path.join(cwd, 'base.txt'), 'base\n'); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', 'base']); }

  // A Latin-1 file: bytes that are not UTF-8 must survive the round trip.
  const latin = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
  await writeFile(path.join(source, 'latin.txt'), latin); await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'Add a Latin-1 file', '--author', 'Someone Else <else@example.invalid>', '--date', '2020-02-02T10:00:00Z']);
  const one = await git(source, ['rev-parse', 'HEAD']);
  await writeFile(path.join(source, 'second file.txt'), 'second\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'Add a second file']);
  const two = await git(source, ['rev-parse', 'HEAD']);

  const file = path.join(root, 'series.patch');
  const exported = await exportPatches({ cwd: source, log, oids: [one, two], target: file });
  assert.deepEqual({ ...exported, bytes: exported.bytes > 0 }, { ok: true, message: null, count: 2, bytes: true, path: file });
  const content = await readFile(file);
  assert.ok(content.includes(Buffer.from([0x2b, 0x63, 0x61, 0x66, 0xe9])), 'the Latin-1 bytes are in the file untouched');
  const summary = inspectPatch(content);
  assert.equal(summary.kind, 'mbox');
  assert.deepEqual(summary.commits, ['Add a Latin-1 file', 'Add a second file'], 'oldest first, as exported');
  assert.deepEqual(summary.files, ['latin.txt', 'second file.txt']);
  const leaked = log.list().filter(entry => entry.stdout?.includes('caf'));
  assert.deepEqual(leaked.map(entry => entry.argv.join(' ')), [], 'the patch text does not go through the journal');

  // Into the other repository, as the same two commits.
  assert.deepEqual(await checkPatch({ cwd: target, log, file }), { applies: true, reason: null });
  const applied = await applyPatch({ cwd: target, log, kind: 'mbox', file });
  assert.deepEqual(applied, { ok: true, message: null });
  assert.equal(await git(target, ['log', '--format=%s|%an|%aI', '-2']), 'Add a second file|Twig Check|' + (await git(source, ['log', '-1', '--format=%aI', two])) + '\nAdd a Latin-1 file|Someone Else|2020-02-02T10:00:00Z',
    'authors, dates and messages travel with the commits');
  assert.deepEqual(await readFile(path.join(target, 'latin.txt')), latin, 'the file is byte for byte the same');

  // A merge commit has no single diff: nothing is written.
  await git(source, ['checkout', '-b', 'side', one]); await writeFile(path.join(source, 'side.txt'), 's\n'); await git(source, ['add', '.']); await git(source, ['commit', '-m', 'side']);
  await git(source, ['checkout', 'main']); await git(source, ['merge', '--no-ff', '--no-edit', 'side']);
  const merged = await exportPatches({ cwd: source, log, oids: [await git(source, ['rev-parse', 'HEAD'])], target: path.join(root, 'merge.patch') });
  assert.equal(merged.ok, false); assert.match(merged.message, /merge commit/);
  await assert.rejects(readFile(path.join(root, 'merge.patch')), /ENOENT/);

  // A conflicting mbox stops as `am`, not as a rebase, with its step.
  await writeFile(path.join(target, 'second file.txt'), 'changed here\n'); await git(target, ['commit', '-am', 'local change']);
  await writeFile(path.join(source, 'second file.txt'), 'changed there\n'); await git(source, ['commit', '-am', 'upstream change']);
  const conflictFile = path.join(root, 'conflict.patch');
  await exportPatches({ cwd: source, log, oids: [await git(source, ['rev-parse', 'HEAD'])], target: conflictFile });
  assert.equal((await checkPatch({ cwd: target, log, file: conflictFile })).applies, false);
  const stopped = await applyPatch({ cwd: target, log, kind: 'mbox', file: conflictFile });
  assert.equal(stopped.ok, false);
  const gitDir = await resolveGitDir({ cwd: target, log });
  const state = await loadOperationState({ cwd: target, log, gitDir });
  assert.equal(state.kind, 'am', 'git am in progress is its own operation, so the banner runs am --continue, not rebase --continue');
  assert.equal(state.step, 1); assert.equal(state.total, 1);
  assert.deepEqual(state.conflicts, ['second file.txt']);
  assert.equal((await sequencer({ cwd: target, log, gitDir, kind: 'am', step: 'abort' })).ok, true);
  assert.equal((await loadOperationState({ cwd: target, log, gitDir })).kind, 'none');

  // A plain diff goes to the files only (and, if asked, the index).
  await writeFile(path.join(root, 'plain.diff'), 'diff --git a/base.txt b/base.txt\n--- a/base.txt\n+++ b/base.txt\n@@ -1 +1,2 @@\n base\n+more\n');
  const plain = inspectPatch(await readFile(path.join(root, 'plain.diff')));
  assert.deepEqual(plain, { kind: 'diff', commits: [], files: ['base.txt'], patches: 0, valid: true });
  const head = await git(target, ['rev-parse', 'HEAD']);
  assert.equal((await applyPatch({ cwd: target, log, kind: 'diff', file: path.join(root, 'plain.diff'), index: true })).ok, true);
  assert.equal(await git(target, ['diff', '--cached', '--name-only']), 'base.txt', 'staged with --index');
  assert.equal(await git(target, ['rev-parse', 'HEAD']), head, 'no commit is made');
  await git(target, ['reset', '--hard']);
  const failed = await applyPatch({ cwd: target, log, kind: 'diff', file: conflictFile });
  assert.equal(failed.ok, false, 'a diff that does not apply changes nothing');
  assert.equal(await git(target, ['status', '--porcelain']), '');
  assert.equal(inspectPatch('just some notes\n').valid, false);

  // Undo: commits from am go back with one reset; a diff applied to the files ends the chain.
  const idle = { head: null, branch: 'main', paths: [], clean: true, operation: 'none' };
  assert.deepEqual(buildUndoPlan({ kind: 'patch:am', before: { ...idle, head: A }, after: { ...idle, head: B }, args: ['token'] }, 'undo').commands, [['reset', '--hard', A]]);
  assert.match(inverseReason('patch:apply', idle, idle, ['token', false]), /ends the Undo chain/);
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Patch checks passed: export to one mbox oldest first with bytes intact, am into another repository with authors and dates, merge refused, am recognised as its own operation, apply with and without --index, all-or-nothing failure, tokens, Undo.');
