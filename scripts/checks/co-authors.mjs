import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { buildCommitArgv, createCommit } from '../../main/git/commit-ops.js';
import { SCAN_LIMIT, buildCoAuthorsArgv, buildOwnEmailArgv, loadCoAuthors, parseCoAuthors } from '../../main/git/co-authors.js';
import { CO_AUTHOR_LIMIT, coAuthorArgv, coAuthorTrailer, filterCoAuthors, missingCoAuthors, validateCoAuthor, validateCoAuthors } from '../../main/git/co-author-trailer.js';

// Co-authors: people who already authored commits here, each one a
// `Co-authored-by:` trailer that Git itself places in the message.

// --- the trailer module, no Git --------------------------------------------------------------
const ann = { name: 'Ann Lee', email: 'ann@example.invalid' };
const bob = { name: 'Bob', email: 'bob@example.invalid' };
assert.equal(coAuthorTrailer(ann), 'Co-authored-by: Ann Lee <ann@example.invalid>');
assert.deepEqual(validateCoAuthor({ name: '  Ann Lee ', email: ' ann@example.invalid ' }), ann, 'surrounding space is trimmed');
for (const bad of [null, 'Ann', { name: 'Ann' }, { name: '', email: 'a@b' }, { name: 'Ann <x>', email: 'a@b' },
  { name: 'Ann\nSigned-off-by: Mallory', email: 'a@b' }, { name: 'Ann', email: 'no-at-sign' }, { name: 'Ann', email: 'a b@c' },
  { name: 'Ann', email: 'a@b>' }, { name: 'Ann', email: 'a@b\0' }, { name: 'x'.repeat(201), email: 'a@b' }]) {
  assert.throws(() => validateCoAuthor(bad), TypeError, JSON.stringify(bad));
}
assert.deepEqual(validateCoAuthors([ann, { ...ann, email: 'ANN@example.invalid' }, bob]), [ann, bob], 'one trailer per e-mail, case-insensitively');
assert.throws(() => validateCoAuthors(Array.from({ length: CO_AUTHOR_LIMIT + 1 }, (_, i) => ({ name: `P${i}`, email: `p${i}@x.invalid` }))), TypeError);
assert.throws(() => validateCoAuthors('ann'), TypeError);
assert.deepEqual(coAuthorArgv([ann]), ['--trailer=Co-authored-by: Ann Lee <ann@example.invalid>'], 'one argv word: the value can never read as an option');
assert.deepEqual(buildCommitArgv(), ['commit', '--file=-', '--cleanup=strip']);
assert.deepEqual(buildCommitArgv({ amend: true, coAuthors: [ann, bob] }),
  ['commit', '--file=-', '--cleanup=strip', '--amend', '--trailer=Co-authored-by: Ann Lee <ann@example.invalid>', '--trailer=Co-authored-by: Bob <bob@example.invalid>']);
assert.throws(() => buildCommitArgv({ coAuthors: [{ name: '--amend', email: 'x' }] }), TypeError);
assert.deepEqual(missingCoAuthors('Fix\n\nco-authored-by: ann lee <ANN@example.invalid>\nCo-authored-by: Bob <bob@example.invalid>', [ann, bob, { name: 'Carol', email: 'c@x.invalid' }]),
  [{ name: 'Carol', email: 'c@x.invalid' }], 'a trailer the message already carries is not added again');
{
  const people = [ann, bob, { name: 'Carol', email: 'carol@corp.invalid' }];
  assert.deepEqual(filterCoAuthors(people, 'corp', []).map(p => p.name), ['Carol'], 'matches the e-mail too');
  assert.deepEqual(filterCoAuthors(people, 'LEE', []).map(p => p.name), ['Ann Lee'], 'case-insensitive');
  assert.deepEqual(filterCoAuthors(people, '', [{ email: 'ANN@example.invalid' }]).map(p => p.name), ['Bob', 'Carol'], 'the chosen are not offered again');
  assert.equal(filterCoAuthors(people, '', [], 2).length, 2);
}
assert.ok(buildCoAuthorsArgv().indexOf('--exclude=refs/twig/*') < buildCoAuthorsArgv().indexOf('--all'), '--exclude must precede --all');
assert.ok(buildCoAuthorsArgv().includes(`--max-count=${SCAN_LIMIT}`), 'the scan is bounded');
assert.deepEqual(buildOwnEmailArgv(), ['config', '--default', '', '--get', 'user.email'], 'an unset e-mail is an empty answer, not exit code 1');
assert.deepEqual(parseCoAuthors('Ann Lee\0ann@x.invalid\0Me\0me@x.invalid\0Ann\0ANN@x.invalid\0Bob\0bob@x.invalid\0🌱 Twig\0twig@localhost\0Bad <x>\0bad@x.invalid\0', 'ME@x.invalid'),
  [{ name: 'Ann Lee', email: 'ann@x.invalid', commits: 2 }, { name: 'Bob', email: 'bob@x.invalid', commits: 1 }],
  'counted per e-mail with the newest spelling; yourself, 🌱 Twig backups and malformed names left out');

// --- a real repository -----------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-co-authors-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const options = { cwd, log };
  const git = async (argv, env = null) => { const result = await runGit({ ...options, argv, env }); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  await git(['init', '--initial-branch=main']);
  assert.deepEqual(await loadCoAuthors(options), { people: [], scanned: 0 }, 'an empty repository has nobody to credit');
  for (const [key, value] of [['user.name', 'Me Myself'], ['user.email', 'me@example.invalid'], ['commit.gpgsign', 'false']]) await git(['config', key, value]);
  const as = (name, email) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email });
  let n = 0;
  const commitAs = async (name, email) => { n += 1; await writeFile(path.join(cwd, `f${n}.txt`), `${n}\n`); await git(['add', '.']); await git(['commit', '-q', '-m', `c${n}`], as(name, email)); };
  await commitAs('Ann Lee', 'ann@example.invalid');
  await commitAs('Ann Lee', 'ann@example.invalid');
  await commitAs('Bob', 'bob@example.invalid');
  await commitAs('Me Myself', 'me@example.invalid');
  // A backup under refs/twig and a stash are not authorship.
  const tree = (await git(['write-tree'])).trim();
  const backup = (await runGit({ ...options, argv: ['commit-tree', tree, '-m', 'backup'], env: { GIT_AUTHOR_NAME: 'Ghost', GIT_AUTHOR_EMAIL: 'ghost@example.invalid' } })).stdout.trim();
  await git(['update-ref', 'refs/twig/discard', backup]);
  // .mailmap folds a second spelling into one person.
  await writeFile(path.join(cwd, '.mailmap'), 'Bob Builder <bob@example.invalid> <bob.old@example.invalid>\n');
  await commitAs('bobby', 'bob.old@example.invalid');

  const { people } = await loadCoAuthors(options);
  assert.deepEqual(people.map(p => [p.name, p.email, p.commits]), [['Ann Lee', 'ann@example.invalid', 2], ['Bob Builder', 'bob@example.invalid', 2]],
    'authors from history, most commits first; yourself and the backup identity are left out; .mailmap is honoured');

  // A commit with two co-authors: the trailers are Git's, after a blank line.
  await writeFile(path.join(cwd, 'g.txt'), 'g\n'); await git(['add', 'g.txt']);
  await createCommit({ ...options, message: 'Pair on g\n\nBody text', coAuthors: [ann, bob] });
  assert.equal((await git(['log', '-1', '--format=%B'])).trim(),
    'Pair on g\n\nBody text\n\nCo-authored-by: Ann Lee <ann@example.invalid>\nCo-authored-by: Bob <bob@example.invalid>');
  assert.equal((await git(['log', '-1', '--format=%(trailers:key=Co-authored-by,valueonly,separator=|)'])).trim(),
    'Ann Lee <ann@example.invalid>|Bob <bob@example.invalid>', 'Git reads them back as trailers');
  // Amending with the same co-author does not repeat it.
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  await createCommit({ ...options, message: 'Pair on g\n\nBody text\n\nCo-authored-by: Ann Lee <ann@example.invalid>\nCo-authored-by: Bob <bob@example.invalid>', amend: true, expectedHead: head, coAuthors: [ann] });
  assert.equal((await git(['log', '-1', '--format=%B'])).match(/Co-authored-by: Ann Lee/g).length, 1, 'an amend keeps one trailer per person');
  // A subject-only message still gets its trailer block.
  await writeFile(path.join(cwd, 'h.txt'), 'h\n'); await git(['add', 'h.txt']);
  await createCommit({ ...options, message: 'Just a subject', coAuthors: [bob] });
  assert.equal((await git(['log', '-1', '--format=%B'])).trim(), 'Just a subject\n\nCo-authored-by: Bob <bob@example.invalid>');
  // Without co-authors, nothing is added.
  await writeFile(path.join(cwd, 'i.txt'), 'i\n'); await git(['add', 'i.txt']);
  await createCommit({ ...options, message: 'Solo' });
  assert.equal((await git(['log', '-1', '--format=%B'])).trim(), 'Solo');
  // A malformed co-author is refused before Git runs: nothing is committed.
  await writeFile(path.join(cwd, 'j.txt'), 'j\n'); await git(['add', 'j.txt']);
  const before = (await git(['rev-parse', 'HEAD'])).trim();
  await assert.rejects(() => createCommit({ ...options, message: 'x', coAuthors: [{ name: 'Eve\nSigned-off-by: Mallory', email: 'e@x' }] }), TypeError);
  assert.equal((await git(['rev-parse', 'HEAD'])).trim(), before);
  const journal = await readFile(path.join(root, 'command-log.jsonl'), 'utf8');
  assert.match(journal, /--trailer=Co-authored-by: Ann Lee <ann@example\.invalid>/, 'the console shows the exact trailers');

  // The channel validates before the Undo record opens, and the form shows the same trailer line.
  const ipc = await readFile(new URL('../../main/worktree-ipc.js', import.meta.url), 'utf8');
  assert.match(ipc, /handler\('worktree:commit', 5,/);
  assert.match(ipc, /coAuthors: validateCoAuthors\(coAuthors\)/);
  const form = await readFile(new URL('../../renderer/src/features/worktree/CoAuthors.jsx', import.meta.url), 'utf8');
  assert.match(form, /coAuthorTrailer\(person\)/, 'the preview is built by the module main uses');
  assert.match(form, /window\.twig\.getCoAuthors\(repositoryId\)/);
  console.log('co-authors check: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
