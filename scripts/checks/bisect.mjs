import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import {
  buildBisectMarkArgv, buildBisectRefsArgv, buildBisectResetArgv, buildBisectStartArgv, buildBisectVarsArgv,
  loadBisectState, parseBisectRefs, parseBisectVars, runBisect, validateTerm
} from '../../main/git/bisect.js';

// Bisect is a search Git drives by checking commits out. Only a real
// repository can show that the commit it lands on is the one that broke the
// file, so this check plants a defect and asserts that bisect finds it.

// --- pure argv and parsing, no Git ---

const OID = 'a'.repeat(40);
assert.deepEqual(buildBisectStartArgv(), ['bisect', 'start']);
assert.deepEqual(buildBisectStartArgv(OID), ['bisect', 'start', OID]);
assert.deepEqual(buildBisectMarkArgv('bad'), ['bisect', 'bad']);
assert.deepEqual(buildBisectMarkArgv('good', { bad: 'bad', good: 'good' }, OID), ['bisect', 'good', OID]);
assert.deepEqual(buildBisectMarkArgv('skip', { bad: 'broken', good: 'works' }), ['bisect', 'skip'],
  'skip keeps its name whatever the terms are');
assert.deepEqual(buildBisectMarkArgv('bad', { bad: 'broken', good: 'works' }), ['bisect', 'broken']);
assert.deepEqual(buildBisectResetArgv(), ['bisect', 'reset']);
for (const bad of ['run', 'log', 'replay', 'start', '', null]) assert.throws(() => buildBisectMarkArgv(bad), TypeError);
for (const bad of ['HEAD', 'main', '--all', '', 'abc']) assert.throws(() => buildBisectStartArgv(bad), TypeError);
for (const bad of ['--force', 'Bad', '9lives', '', 'x'.repeat(40), null]) assert.throws(() => validateTerm(bad), TypeError);
assert.equal(validateTerm('term-old'), 'term-old');

assert.deepEqual(buildBisectVarsArgv('refs/bisect/bad', ['refs/bisect/good-1']),
  ['rev-list', '--bisect-vars', 'refs/bisect/bad', '--not', 'refs/bisect/good-1']);
for (const bad of ['refs/heads/main', '--all', 'refs/bisect/../heads/main', '']) {
  assert.throws(() => buildBisectVarsArgv(bad, []), TypeError, `${bad} must not reach argv`);
  assert.throws(() => buildBisectVarsArgv('refs/bisect/bad', [bad]), TypeError);
}
assert.deepEqual(buildBisectRefsArgv(), ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/bisect']);

const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const marks = parseBisectRefs([
  `refs/bisect/bad\0${B}`, `refs/bisect/good-${C}\0${C}`, `refs/bisect/skip-${D}\0${D}`
].join('\n'), { bad: 'bad', good: 'good' });
assert.deepEqual(marks, { bad: B, goods: [C], skipped: [D], goodRefs: [`refs/bisect/good-${C}`], badRef: 'refs/bisect/bad' });
assert.deepEqual(parseBisectRefs(`refs/bisect/broken\0${B}`, { bad: 'broken', good: 'works' }).bad, B);
assert.throws(() => parseBisectRefs(`refs/heads/main\0${B}`, { bad: 'bad', good: 'good' }), /Unexpected bisect ref/);

assert.deepEqual(parseBisectVars("bisect_rev='abc'\nbisect_nr=7\nbisect_steps=3\nbisect_all=15\n"),
  { bisect_rev: 'abc', bisect_nr: '7', bisect_steps: '3', bisect_all: '15' });

// --- real repository ---

const root = await mkdtemp(path.join(tmpdir(), 'twig-bisect-check-'));
const log = new CommandLog(root);

try {
  await log.load();
  const repo = path.join(root, 'work');
  await mkdir(repo, { recursive: true });
  const git = async (argv, allowFailure = false) => {
    const result = await runGit({ argv, cwd: repo, log, operation: 'check' });
    if (!allowFailure) assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result;
  };
  const state = () => loadBisectState({ cwd: repo, log });
  const broken = async () => (await readFile(path.join(repo, 'app.txt'), 'utf8')).includes('BUG');

  await git(['init', '-q', '-b', 'main', '.']);
  await git(['config', 'user.email', 'check@example.invalid']);
  await git(['config', 'user.name', 'Twig Check']);
  const commits = [];
  for (let i = 1; i <= 16; i += 1) {
    await writeFile(path.join(repo, 'app.txt'), `line ${i}\n${i >= 9 ? 'BUG\n' : ''}`);
    await git(['add', 'app.txt']);
    await git(['commit', '-q', '-m', `c${i}`]);
    commits.push((await git(['rev-parse', 'HEAD'])).stdout.trim());
  }
  const firstBroken = commits[8];

  assert.deepEqual(await state(), {
    active: false, terms: { bad: 'bad', good: 'good' }, start: null, bad: null, goods: [], skipped: [],
    expected: null, remaining: null, steps: null, done: false, firstBad: null
  }, 'a repository with no bisect reports none');

  // 1. Start with the broken tip, then name a working ancestor.
  assert.deepEqual(await runBisect({ cwd: repo, log, step: 'start', oid: commits.at(-1) }), { ok: true, message: null });
  let current = await state();
  assert.equal(current.active, true);
  assert.equal(current.start, 'main', 'the branch to return to is recorded');
  assert.equal(current.bad, commits.at(-1));
  assert.deepEqual(current.goods, [], 'nothing is known to work yet');
  assert.equal(current.remaining, null, 'without a good commit there is nothing to count');

  await runBisect({ cwd: repo, log, step: 'good', oid: commits[0] });
  current = await state();
  assert.equal(current.goods.length, 1);
  assert.equal(current.done, false);
  assert.ok(current.remaining > 0, 'Git reports how much of the range is left');
  assert.ok(current.steps > 0);
  assert.equal(current.expected, (await git(['rev-parse', 'HEAD'])).stdout.trim(), 'the revision to test is checked out');

  // 2. Answer for each revision Git offers until the search ends.
  for (let guard = 0; guard < 20 && !current.done; guard += 1) {
    await runBisect({ cwd: repo, log, step: await broken() ? 'bad' : 'good' });
    current = await state();
  }
  assert.equal(current.done, true, 'the search finished');
  assert.equal(current.firstBad, firstBroken, 'bisect found the commit that introduced the defect');
  assert.equal(current.remaining, 0);

  // 3. Ending a bisect puts the branch back.
  await runBisect({ cwd: repo, log, step: 'reset' });
  assert.equal((await state()).active, false);
  assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main');

  // 4. A revision that cannot be judged is skipped, and the skip is visible.
  await runBisect({ cwd: repo, log, step: 'start', oid: commits.at(-1) });
  await runBisect({ cwd: repo, log, step: 'good', oid: commits[0] });
  const skipped = (await state()).expected;
  await runBisect({ cwd: repo, log, step: 'skip' });
  current = await state();
  assert.deepEqual(current.skipped, [skipped], 'the skipped revision is recorded');
  assert.notEqual(current.expected, skipped, 'Git offers a different revision after a skip');
  await runBisect({ cwd: repo, log, step: 'reset' });

  // 5. A bisect started elsewhere may use other words, and Git then answers to
  // those alone. The state reports them and the marks are spelled back.
  await git(['bisect', 'start', '--term-old=works', '--term-new=broken']);
  const custom = await state();
  assert.deepEqual(custom.terms, { bad: 'broken', good: 'works' });
  await runBisect({ cwd: repo, log, step: 'bad', oid: commits.at(-1), terms: custom.terms });
  await runBisect({ cwd: repo, log, step: 'good', oid: commits[0], terms: custom.terms });
  current = await state();
  assert.equal(current.bad, commits.at(-1), 'the mark landed on refs/bisect/broken');
  assert.equal(current.goods.length, 1);
  assert.ok(current.remaining > 0, 'counting works with custom terms too');
  await runBisect({ cwd: repo, log, step: 'reset' });

  // 6. A refused command is a result, not a crash: nothing is bisecting now.
  const refused = await runBisect({ cwd: repo, log, step: 'good' });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /did not finish/);

  console.log('bisect check: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
