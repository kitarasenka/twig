import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { buildPatch, PatchBuildError } from '../../main/git/patch-builder.js';
import { parseFilePatchV1 } from '../../main/git/diff-parser.js';
import { loadWorktree, loadWorktreeDiff } from '../../main/git/worktree.js';

// A built patch is only worth anything if real `git apply --cached` accepts it
// and stages exactly the selected lines, so this check runs against a
// throwaway repository. Every mutation happens inside that temp repository;
// the module code under test never mutates anything.

const root = await mkdtemp(path.join(tmpdir(), 'twig-patch-check-'));
const cwd = path.join(root, 'fixture');
const patchFile = path.join(root, 'staged.patch');
const log = new CommandLog(root);

// --- pure-logic checks first, no Git needed ---

const sample = parseFilePatchV1([
  'diff --git a/a.txt b/a.txt',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' keep',
  '-old',
  '+new',
  ' tail',
  ''
].join('\n'));

assert.equal(buildPatch({ path: 'a.txt', hunks: sample.hunks, selection: [] }), null, 'nothing selected builds no patch');
assert.equal(buildPatch({ path: 'a.txt', hunks: sample.hunks, selection: [{ index: 0, lines: [0] }] }), null,
  'selecting only a context line changes nothing');

for (const selection of [[{ index: 9, lines: 'all' }], [{ index: 0, lines: [99] }], [{ index: 0, lines: 'some' }],
  [{ index: 0, lines: 'all' }, { index: 0, lines: 'all' }]]) {
  assert.throws(() => buildPatch({ path: 'a.txt', hunks: sample.hunks, selection }), PatchBuildError);
}
assert.throws(() => buildPatch({ path: '', hunks: sample.hunks, selection: [{ index: 0, lines: 'all' }] }), PatchBuildError);

// The path is terminated with a tab so a name containing spaces stays unambiguous.
{
  const patch = buildPatch({ path: 'sp ace.txt', hunks: sample.hunks, selection: [{ index: 0, lines: 'all' }] });
  assert.ok(patch.includes('--- a/sp ace.txt\t'));
  assert.ok(patch.includes('+++ b/sp ace.txt\t'));
  assert.ok(patch.endsWith('\n'));
}

// Staging drops an unselected addition and demotes an unselected deletion to
// context; unstaging mirrors that. Same input, opposite directions.
{
  const forward = buildPatch({ path: 'a.txt', hunks: sample.hunks, selection: [{ index: 0, lines: [1] }] });
  assert.ok(forward.includes('\n-old\n'), 'selected deletion stays a deletion');
  assert.equal(forward.includes('+new'), false, 'unselected addition is dropped when staging');
  assert.ok(forward.includes('@@ -1,3 +1,2 @@'), 'counts follow the filtered lines');

  const backward = buildPatch({ path: 'a.txt', hunks: sample.hunks, selection: [{ index: 0, lines: [1] }], reverse: true });
  assert.ok(backward.includes('\n-old\n'));
  assert.ok(backward.includes('\n new\n'), 'unselected addition becomes context when unstaging');
  // Unstaging keeps the deletion and turns the addition into context, so the
  // reconstructed old side gains a line the parsed old side did not have.
  assert.ok(backward.includes('@@ -1,4 +1,3 @@'));
}

// Line numbering mirrors with `reverse`: the side git matches against the
// index keeps its parsed numbers. `git apply` searches around the stated line
// and would accept wrong numbers here, so this is asserted on the text.
{
  const shifted = parseFilePatchV1([
    'diff --git a/s.txt b/s.txt',
    '--- a/s.txt',
    '+++ b/s.txt',
    '@@ -10,3 +14,4 @@',
    ' before',
    '-gone',
    '+first',
    '+second',
    ' after',
    ''
  ].join('\n'));
  const staged = buildPatch({ path: 's.txt', hunks: shifted.hunks, selection: [{ index: 0, lines: [2] }] });
  assert.ok(staged.includes('@@ -10,3 +10,4 @@'), `staging keeps the old start, got: ${staged.split('\n')[3]}`);

  const unstaged = buildPatch({ path: 's.txt', hunks: shifted.hunks, selection: [{ index: 0, lines: [2] }], reverse: true });
  assert.ok(unstaged.includes('@@ -14,3 +14,4 @@'), `unstaging keeps the new start, got: ${unstaged.split('\n')[3]}`);
}

try {
  await mkdir(cwd, { recursive: true });
  await log.load();
  const git = async (argv, allowFailure = false) => {
    const result = await runGit({ argv, cwd, log, operation: 'check' });
    if (!allowFailure) assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result;
  };
  const commit = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit'];
  const indexContent = async file => (await git(['show', `:${file}`])).stdout;
  const apply = async (patch, extra = []) => {
    await writeFile(patchFile, patch, 'utf8');
    return git(['apply', '--cached', ...extra, patchFile], true);
  };

  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);

  const base = Array.from({ length: 20 }, (_, i) => `line${String(i + 1).padStart(2, '0')}`);
  const file = 'work.txt';
  await writeFile(path.join(cwd, file), `${base.join('\n')}\n`, 'utf8');
  await git(['add', '--', `:(literal)${file}`]);
  await git([...commit, '-m', 'base']);

  // Two separate hunks: an edit plus an insertion near the top, an edit at the bottom.
  const changed = [...base];
  changed[1] = 'LINE02';
  changed.splice(3, 0, 'inserted');
  changed[changed.length - 3] = 'LINE18';
  await writeFile(path.join(cwd, file), `${changed.join('\n')}\n`, 'utf8');

  const diff = await loadWorktreeDiff({ cwd, log, path: file });
  assert.equal(diff.hunks.length, 2, 'fixture should produce two hunks');
  assert.equal(diff.binary, false);

  // 1. Stage the second hunk only. The first hunk must stay unstaged.
  {
    const patch = buildPatch({ path: file, hunks: diff.hunks, selection: [{ index: 1, lines: 'all' }] });
    const applied = await apply(patch);
    assert.equal(applied.code, 0, `git apply rejected the patch: ${applied.stderr}`);
    const staged = (await indexContent(file)).split('\n');
    assert.equal(staged.includes('LINE18'), true, 'selected hunk reached the index');
    assert.equal(staged.includes('LINE02'), false, 'unselected hunk stayed out of the index');
    assert.equal(staged.includes('inserted'), false);
    assert.equal(staged.includes('line02'), true);
    await git(['reset', '-q']);
  }

  // 2. Stage a single added line out of a hunk that also carries an edit.
  {
    const [hunk] = diff.hunks;
    const insertedAt = hunk.lines.findIndex(line => line.kind === 'add' && line.text === 'inserted');
    assert.ok(insertedAt > 0, 'fixture hunk should contain the inserted line');
    const patch = buildPatch({ path: file, hunks: diff.hunks, selection: [{ index: 0, lines: [insertedAt] }] });
    const applied = await apply(patch);
    assert.equal(applied.code, 0, `git apply rejected the partial patch: ${applied.stderr}`);
    const staged = (await indexContent(file)).split('\n');
    assert.equal(staged.includes('inserted'), true, 'the selected line reached the index');
    assert.equal(staged.includes('LINE02'), false, 'the unselected edit did not');
    assert.equal(staged.includes('line02'), true, 'the unselected deletion stayed in the index as context');
    assert.equal(staged.includes('LINE18'), false);
    await git(['reset', '-q']);
  }

  // 3. Two hunks at once: the second hunk's new-side start must shift by the
  //    first hunk's delta, otherwise git rejects the patch.
  {
    const patch = buildPatch({ path: file, hunks: diff.hunks, selection: [{ index: 0, lines: 'all' }, { index: 1, lines: 'all' }] });
    const applied = await apply(patch);
    assert.equal(applied.code, 0, `git apply rejected the multi-hunk patch: ${applied.stderr}`);
    assert.equal(await indexContent(file), `${changed.join('\n')}\n`, 'staging every hunk equals staging the file');
    await git(['reset', '-q']);
  }

  // 4. Unstaging: stage everything, then reverse-apply a one-line selection.
  {
    await git(['add', '--', `:(literal)${file}`]);
    const cached = await loadWorktreeDiff({ cwd, log, path: file, staged: true });
    const hunkIndex = cached.hunks.findIndex(hunk => hunk.lines.some(line => line.text === 'LINE18'));
    const lineIndex = cached.hunks[hunkIndex].lines.findIndex(line => line.text === 'LINE18');
    const patch = buildPatch({
      path: file, hunks: cached.hunks, reverse: true,
      selection: [{ index: hunkIndex, lines: [lineIndex, lineIndex - 1] }]
    });
    const applied = await apply(patch, ['--reverse']);
    assert.equal(applied.code, 0, `git apply --reverse rejected the patch: ${applied.stderr}`);
    const staged = (await indexContent(file)).split('\n');
    assert.equal(staged.includes('LINE18'), false, 'the selected change was unstaged');
    assert.equal(staged.includes('line18'), true);
    assert.equal(staged.includes('LINE02'), true, 'the rest of the index was left alone');
    assert.equal(staged.includes('inserted'), true);
    await git(['reset', '-q']);
  }

  // 5. A file whose last line loses its trailing newline: the marker has to
  //    travel with the line it belongs to or the patch corrupts the ending.
  {
    const tail = 'tail.txt';
    await writeFile(path.join(cwd, tail), 'alpha\nomega\n', 'utf8');
    await git(['add', '--', `:(literal)${tail}`]);
    await git([...commit, '-m', 'tail']);
    await writeFile(path.join(cwd, tail), 'alpha\nOMEGA', 'utf8');
    const tailDiff = await loadWorktreeDiff({ cwd, log, path: tail });
    assert.ok(tailDiff.hunks[0].lines.some(line => line.noNewline), 'fixture should carry a no-newline marker');
    const patch = buildPatch({ path: tail, hunks: tailDiff.hunks, selection: [{ index: 0, lines: 'all' }] });
    const applied = await apply(patch);
    assert.equal(applied.code, 0, `git apply rejected the no-newline patch: ${applied.stderr}`);
    assert.equal(await indexContent(tail), 'alpha\nOMEGA', 'the staged file keeps its missing final newline');
    await git(['reset', '-q']);
  }

  // 6. A newly added file staged through a patch, and a path containing a space.
  {
    const spaced = 'sp ace.txt';
    await writeFile(path.join(cwd, spaced), 'first\nsecond\n', 'utf8');
    await git(['add', '-N', '--', `:(literal)${spaced}`]);
    const addedDiff = await loadWorktreeDiff({ cwd, log, path: spaced });
    assert.equal(addedDiff.added, true);
    const patch = buildPatch({
      path: spaced, hunks: addedDiff.hunks, added: true, mode: addedDiff.mode,
      selection: [{ index: 0, lines: [0] }]
    });
    const applied = await apply(patch);
    assert.equal(applied.code, 0, `git apply rejected the added-file patch: ${applied.stderr}`);
    assert.equal(await indexContent(spaced), 'first\n', 'only the selected line of the new file was staged');
    await git(['reset', '-q']);
  }

  // 7. loadWorktree splits the same file into both lists when it is staged and
  //    then modified again, and reports untracked files separately.
  {
    await writeFile(path.join(cwd, file), `${changed.join('\n')}\nextra\n`, 'utf8');
    await git(['add', '--', `:(literal)${file}`]);
    await writeFile(path.join(cwd, file), `${changed.join('\n')}\nextra\nmore\n`, 'utf8');
    await writeFile(path.join(cwd, 'fresh.txt'), 'brand new\n', 'utf8');
    const tree = await loadWorktree({ cwd, log });
    assert.equal(tree.staged.some(entry => entry.path === file), true, 'staged change is listed');
    assert.equal(tree.unstaged.some(entry => entry.path === file), true, 'further worktree change is listed too');
    assert.equal(tree.untracked.some(entry => entry.path === 'fresh.txt'), true);
    assert.equal(tree.untracked[0].status, '?');
    assert.equal(tree.branch.name, 'main');
    await git(['reset', '-q']);
  }

  console.log('patch-builder: all checks passed against real git apply --cached');
} finally {
  await rm(root, { recursive: true, force: true });
}
