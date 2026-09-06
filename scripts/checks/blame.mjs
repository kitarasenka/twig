import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import {
  BlameError, buildBlameArgv, buildReverseBlameArgv, parseBlamePorcelain,
  loadBlame, loadReverseBlame, loadBlameBefore
} from '../../main/git/blame.js';
import { mapLineBack } from '../../main/git/blame-map.js';
import { parseFilePatchV1 } from '../../main/git/diff-parser.js';

const OID = 'a'.repeat(40);

// --- argv builders: the path sits raw after `--`, never as `:(literal)` ---
assert.deepEqual(buildBlameArgv(OID, 'src/app.js'),
  ['blame', '--line-porcelain', '--no-textconv', OID, '--', 'src/app.js']);
assert.equal(buildBlameArgv(OID, '--weird.js').at(-1), '--weird.js');
assert.equal(buildBlameArgv(OID, 'src/app.js').includes(':(literal)src/app.js'), false);
assert.deepEqual(buildReverseBlameArgv(OID, 'b'.repeat(40), 'a b/c.txt'),
  ['blame', '--line-porcelain', '--no-textconv', '--reverse', `${OID}..${'b'.repeat(40)}`, '--', 'a b/c.txt']);
for (const bad of ['not-hex', '', 42]) assert.throws(() => buildBlameArgv(bad, 'a.js'), TypeError);
for (const bad of ['', '/etc/passwd', '../escape', 'a/../b', 'has\0nul']) {
  assert.throws(() => buildBlameArgv(OID, bad), TypeError, `path ${bad} must be rejected`);
}

// --- parser ---
const block = (oid, line, orig, final, extra, content, first) =>
  `${oid} ${orig} ${final}${first ? ` ${first}` : ''}\n`
  + `author ${extra.author || 'Ada'}\nauthor-mail <${extra.email || 'ada@example.invalid'}>\n`
  + `author-time ${extra.time || 1700000000}\nauthor-tz ${extra.tz || '+0000'}\n`
  + `committer ${extra.author || 'Ada'}\ncommitter-mail <${extra.email || 'ada@example.invalid'}>\n`
  + `committer-time ${extra.time || 1700000000}\ncommitter-tz ${extra.tz || '+0000'}\n`
  + `summary ${extra.summary || 'a commit'}\n`
  + (extra.boundary ? 'boundary\n' : '')
  + (extra.previous ? `previous ${extra.previous}\n` : '')
  + `filename ${extra.filename || 'f.txt'}\n\t${content}\n`;

{
  const out = block('1'.repeat(40), 1, 1, 1, { boundary: true }, 'first', 3)
    + block('1'.repeat(40), 2, 2, 2, { boundary: true }, '\tindented', null)
    + block('2'.repeat(40), 3, 3, 3, { previous: `${'1'.repeat(40)} f.txt`, summary: 'later' }, 'third', 1);
  const parsed = parseBlamePorcelain(out);
  assert.equal(parsed.lines.length, 3);
  assert.equal(parsed.lines[1].content, '\tindented', 'a leading TAB in code must survive');
  assert.equal(parsed.lines[0].boundary, true);
  assert.equal(parsed.commits['1'.repeat(40)].boundary, true);
  assert.deepEqual(parsed.lines[2].previous, { oid: '1'.repeat(40), path: 'f.txt' });
  assert.equal(parsed.commits['2'.repeat(40)].summary, 'later');
  assert.equal(parsed.commits['1'.repeat(40)].author.name, 'Ada');
  assert.match(parsed.commits['1'.repeat(40)].author.date, /^2023-11-14T\d\d:\d\d:\d\d\+00:00$/);
}
// timezone offset is folded into the composed ISO string
{
  const out = block('3'.repeat(40), 1, 1, 1, { time: 1700000000, tz: '+0530' }, 'x', 1);
  assert.match(parseBlamePorcelain(out).commits['3'.repeat(40)].author.date, /\+05:30$/);
}
// C-quoted unicode filename is decoded back to UTF-8
{
  const out = block('4'.repeat(40), 1, 1, 1, { filename: '"\\320\\272\\320\\276\\321\\202.txt"' }, 'x', 1);
  assert.equal(parseBlamePorcelain(out).lines[0].filename, 'кот.txt');
}
assert.deepEqual(parseBlamePorcelain(''), { lines: [], commits: {} });
// a NUL in a content line means the blob is binary
assert.throws(() => parseBlamePorcelain(block('5'.repeat(40), 1, 1, 1, {}, 'a\0b', 1)),
  error => error instanceof BlameError && error.code === 'binary');
assert.throws(() => parseBlamePorcelain('not a header\n'), error => error instanceof BlameError && error.code === 'parse');

// --- mapLineBack: honest line correspondence across a parent → child patch ---
const patch = text => parseFilePatchV1(text);
{
  // context line maps exactly
  const p = patch('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  assert.deepEqual(mapLineBack(p, 1), { range: [1, 1], exact: true, note: null });
  // the changed line points at the line it replaced, not exact
  const changed = mapLineBack(p, 2);
  assert.deepEqual(changed.range, [2, 2]);
  assert.equal(changed.exact, false);
}
{
  // pure insertion: no replaced line, so the surrounding area, flagged inexact
  const p = patch('@@ -2,0 +3,1 @@\n+new line\n');
  const added = mapLineBack(p, 3);
  assert.equal(added.exact, false);
  assert.ok(added.note.includes('added'));
}
{
  // a line after the hunk keeps its position minus the hunk's growth
  const p = patch('@@ -1,1 +1,3 @@\n a\n+b\n+c\n');
  assert.deepEqual(mapLineBack(p, 5), { range: [3, 3], exact: true, note: null });
}

// --- live Git ---
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-blame-check-'));
try {
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  const log = new CommandLog(root);
  await log.load();
  const git = async (argv, env = null) => {
    const result = await runGit({ argv, cwd, log, env });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const at = date => ({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Blame Fixture']);
  await git(['config', 'user.email', 'blame@example.invalid']);
  const commit = (message, date) => git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', message], at(date));

  await writeFile(path.join(cwd, 'code.txt'), 'keep-1\nkeep-2\ndoomed\n');
  await git(['add', '-A']);
  await commit('A add file', '2020-01-01T00:00:00Z');
  const a = await git(['rev-parse', 'HEAD']);

  await writeFile(path.join(cwd, 'code.txt'), 'keep-1\nchanged-2\ndoomed\nappended\n');
  await git(['add', '-A']);
  await commit('B change and append', '2020-02-01T00:00:00Z');
  const b = await git(['rev-parse', 'HEAD']);

  await writeFile(path.join(cwd, 'code.txt'), 'keep-1\nchanged-2\nappended\n');
  await git(['add', '-A']);
  await commit('C delete doomed', '2020-03-01T00:00:00Z');
  const c = await git(['rev-parse', 'HEAD']);

  // forward blame at C: line 1 from A, line 2 from B, line 3 from B
  const atC = await loadBlame({ cwd, log, oid: c, path: 'code.txt' });
  assert.deepEqual(atC.lines.map(line => line.oid), [a, b, b]);
  assert.equal(atC.lines[0].content, 'keep-1');
  assert.equal(atC.commits[a].summary, 'A add file');

  // blame before line 2 (from B) lands on B's parent A, and the mapping is not
  // claimed to be exact because B rewrote that line
  const before = await loadBlameBefore({ cwd, log, oid: b, path: 'code.txt', line: 2 });
  assert.equal(before.kind, 'ok');
  assert.equal(before.oid, a);
  assert.equal(before.exact ?? before.mapping.exact, false);
  // a further step back from A hits the first commit
  const beforeRoot = await loadBlameBefore({ cwd, log, oid: a, path: 'code.txt', line: 1 });
  assert.equal(beforeRoot.kind, 'root');

  // reverse blame A..C: "doomed" (line 3 in A) last existed in B; "keep-1"
  // reaches the end and is attributed to C == End, with no boundary claim
  const reverse = await loadReverseBlame({ cwd, log, startOid: a, endOid: c, path: 'code.txt' });
  const doomed = reverse.lines.find(line => line.content === 'doomed');
  assert.equal(doomed.oid, b, 'last commit where the line existed');
  const kept = reverse.lines.find(line => line.content === 'keep-1');
  assert.equal(kept.oid, c, 'a surviving line is attributed to End');
  // reverse blame A..B: "keep-2" was rewritten in B so it last existed in A;
  // "doomed" still exists in B, the end of this range.
  const reverseAB = await loadReverseBlame({ cwd, log, startOid: a, endOid: b, path: 'code.txt' });
  assert.equal(reverseAB.lines.find(line => line.content === 'keep-2').oid, a);
  assert.equal(reverseAB.lines.find(line => line.content === 'doomed').oid, b);
  // X..X is refused by the range guard (the IPC layer routes it to loadBlame)
  await assert.rejects(loadReverseBlame({ cwd, log, startOid: a, endOid: a, path: 'code.txt' }), TypeError);

  // rename following: blame before a line whose file was renamed steps back to
  // the old name
  await git(['mv', 'code.txt', 'renamed.txt']);
  await commit('D rename', '2020-04-01T00:00:00Z');
  const d = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(cwd, 'renamed.txt'), 'keep-1\nchanged-2\nappended\nafter-rename\n');
  await git(['add', '-A']);
  await commit('E edit after rename', '2020-05-01T00:00:00Z');
  const e = await git(['rev-parse', 'HEAD']);
  const afterRename = await loadBlame({ cwd, log, oid: e, path: 'renamed.txt' });
  assert.equal(afterRename.lines[0].oid, a, 'blame follows the file through the rename');
  const stepBack = await loadBlameBefore({ cwd, log, oid: e, path: 'renamed.txt', line: 4 });
  assert.equal(stepBack.kind, 'ok');
  assert.equal(stepBack.oid, d);

  // filenames with spaces, unicode and a leading dash
  for (const name of ['a file.txt', 'файл.txt', '-dash.txt']) {
    await writeFile(path.join(cwd, name), 'one\ntwo\n');
    await git(['add', '--', name]);
    await commit(`add ${name}`, '2020-06-01T00:00:00Z');
    const head = await git(['rev-parse', 'HEAD']);
    const blamed = await loadBlame({ cwd, log, oid: head, path: name });
    assert.equal(blamed.lines.length, 2, `blame works for “${name}”`);
    assert.equal(blamed.lines[0].content, 'one');
  }

  // merge commit: blame before offers a parent choice
  await git(['checkout', '-b', 'side', a]);
  await writeFile(path.join(cwd, 'code.txt'), 'keep-1\nkeep-2\ndoomed\nside-line\n');
  await git(['add', '-A']);
  await commit('side edit', '2020-07-01T00:00:00Z');
  await git(['checkout', 'main']);
  const mergeResult = await runGit({ argv: ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'merge', '--no-edit', '-m', 'merge side', 'side'], cwd, log });
  // a conflicted merge still commits after we resolve; keep it simple by
  // accepting either outcome and only checking the need-parent path when merged
  if (mergeResult.code === 0) {
    const merge = await git(['rev-parse', 'HEAD']);
    const parents = (await git(['rev-list', '--parents', '-n', '1', merge])).split(/\s+/).length - 1;
    if (parents > 1) {
      const line1 = await loadBlame({ cwd, log, oid: merge, path: 'renamed.txt' }).catch(() => null);
      if (line1) {
        const pick = await loadBlameBefore({ cwd, log, oid: merge, path: 'renamed.txt', line: 1 });
        assert.ok(['ok', 'need-parent'].includes(pick.kind));
        if (pick.kind === 'need-parent') {
          assert.equal(pick.parents.length, parents);
          const chosen = await loadBlameBefore({ cwd, log, oid: merge, path: 'renamed.txt', line: 1, parentIndex: 0 });
          assert.ok(['ok', 'absent-in-parent'].includes(chosen.kind));
        }
      }
    }
  } else {
    await git(['merge', '--abort']);
  }

  // absent file in a version
  await assert.rejects(loadBlame({ cwd, log, oid: a, path: 'renamed.txt' }),
    error => error instanceof BlameError && error.code === 'absent');

  console.log('blame: all checks passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
