import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import {
  buildBisectMarkArgv, buildBisectRefsArgv, buildBisectResetArgv, buildBisectStartArgv, buildBisectVarsArgv,
  loadBisectState, parseBisectLog, parseBisectRefs, parseBisectVars, runBisect, validateTerm
} from '../../main/git/bisect.js';
import { BISECT_KINDS, bisectClass, bisectMarkMap } from '../../renderer/src/features/graph/bisect-marks.js';

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

// Every answer, from the replay script Git writes: the last word on a commit wins,
// prose comments and malformed lines are ignored, custom terms are understood.
{
  const logText = [
    "git bisect start 'HEAD' 'HEAD~7'", '# status: waiting for both good and bad commits',
    `# bad: [${B}] c8`, `git bisect bad ${B}`, `git bisect skip ${C}`, `git bisect good ${C}`,
    `git bisect good ${D.toUpperCase()}`, 'git bisect bad not-a-sha', `git bisect run ${B}`, `git bisect bad ${'e'.repeat(64)}`,
    // The ends given to `start` exist only as comments; a result line is not an answer.
    `# good: [${'1'.repeat(40)}] c1`, `# first bad commit: [${'2'.repeat(40)}] c9`, `# possible first bad commit: [${'3'.repeat(40)}] x`
  ].join('\n');
  assert.deepEqual([...parseBisectLog(logText)], [[B, 'bad'], [C, 'good'], [D, 'good'], ['e'.repeat(64), 'bad'], ['1'.repeat(40), 'good']]);
  assert.deepEqual([...parseBisectLog(`git bisect broken ${B}\ngit bisect works ${C}\ngit bisect bad ${D}`, { bad: 'broken', good: 'works' })],
    [[B, 'bad'], [C, 'good']], 'with custom terms, bad/good are just other words');
  assert.equal(parseBisectLog('').size, 0);
}

// The graph's chips: a word and a kind per commit, nothing while no bisect runs.
{
  assert.equal(bisectMarkMap({ active: false, marked: [{ oid: B, mark: 'bad' }] }).size, 0);
  const map = bisectMarkMap({ active: true, terms: { bad: 'broken', good: 'works' }, expected: D, done: false,
    marked: [{ oid: B.toUpperCase(), mark: 'bad' }, { oid: C, mark: 'good' }, { oid: 'nonsense', mark: 'bad' }, { oid: 'f'.repeat(40), mark: 'run' }] });
  assert.deepEqual(Object.fromEntries([...map].map(([oid, mark]) => [oid[0], [mark.kind, mark.word]])),
    { b: ['bad', 'broken'], c: ['good', 'works'], d: ['testing', 'testing'] }, 'custom terms are the words on the chips; oids are lower-cased');
  assert.match(map.get(B).title, /bug is present/);
  // The revision on test that was already answered keeps its answer.
  assert.equal(bisectMarkMap({ active: true, expected: C, marked: [{ oid: C, mark: 'skip' }] }).get(C).kind, 'skip');
  // Refs alone (an older main) still draw.
  assert.equal(bisectMarkMap({ active: true, bad: B, goods: [C], skipped: [D] }).size, 3);
  // Done: the answer is the culprit, and nothing is "testing" any more.
  const done = bisectMarkMap({ active: true, done: true, firstBad: B, expected: D, marked: [{ oid: B, mark: 'bad' }] });
  assert.deepEqual([done.get(B).kind, done.get(B).word, done.has(D)], ['culprit', 'first bad', false]);
  for (const kind of BISECT_KINDS) assert.equal(bisectClass(kind), `bisect-chip bisect-${kind}`);
  // Every chip class is styled, and each rendered chip carries its word.
  const css = await readFile(new URL('../../renderer/src/ui/history.css', import.meta.url), 'utf8');
  for (const kind of BISECT_KINDS) assert.ok(css.includes(`.bisect-${kind} {`), `.bisect-${kind} is styled`);
  const graph = await readFile(new URL('../../renderer/src/features/graph/CommitGraph.jsx', import.meta.url), 'utf8');
  assert.match(graph, /<Icon aria-hidden="true" \/><span>\{mark\.word\}<\/span>/, 'the chip shows its word, not only an icon');
}

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
    active: false, terms: { bad: 'bad', good: 'good' }, start: null, bad: null, goods: [], skipped: [], marked: [],
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
  const answers = new Map([[commits.at(-1), 'bad'], [commits[0], 'good']]);
  for (let guard = 0; guard < 20 && !current.done; guard += 1) {
    const answer = await broken() ? 'bad' : 'good';
    answers.set(current.expected, answer);
    await runBisect({ cwd: repo, log, step: answer });
    current = await state();
  }
  assert.equal(current.done, true, 'the search finished');
  // Every answer is on its commit — including the earlier `bad` ones, which
  // refs/bisect no longer holds (Git keeps only the newest bad there).
  assert.deepEqual(new Map(current.marked.map(item => [item.oid, item.mark])), answers, 'the graph gets every answer given');
  assert.ok([...answers.values()].filter(mark => mark === 'bad').length > 1, 'the search went through several bad commits');
  const chips = bisectMarkMap(current);
  assert.equal(chips.get(firstBroken).kind, 'culprit', 'the first bad commit is drawn as the result');
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
  assert.equal(new Map(current.marked.map(item => [item.oid, item.mark])).get(skipped), 'skip', 'and drawn as skipped');
  assert.equal(bisectMarkMap(current).get(current.expected).kind, 'testing', 'the next revision is drawn as the one on test');
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
  assert.deepEqual(current.marked.map(item => item.mark).sort(), ['bad', 'good'], 'custom-term answers read back as bad/good');
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
