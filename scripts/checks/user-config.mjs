// The person's own Git config must not change what 🌱 Twig parses. `-c
// color.ui=false` in every command does not override a more specific
// `color.diff = always`, and `diff.noprefix` / `diff.mnemonicPrefix` rename the
// `a/` `b/` sides that diffs are matched to paths by. Before the readers passed
// `--no-color` and explicit prefixes, the commit panel showed escape codes and
// no hunks, and multi-file reads fell back to one Git run per file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { loadCommitDiffs, loadFileDiff } from '../../main/git/commit.js';
import { loadWorktreeDiff, loadWorktreeDiffs } from '../../main/git/worktree.js';
import { loadStashDiff } from '../../main/git/stash.js';
import { searchCommits } from '../../main/git/pickaxe.js';

const root = await mkdtemp(path.join(tmpdir(), 'twig-user-config-'));
try {
  const cwd = path.join(root, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--initial-branch=main', cwd]);
  for (const [key, value] of [['user.name', 'Config Check'], ['user.email', 'config@example.invalid'], ['commit.gpgsign', 'false'],
    ['color.ui', 'always'], ['color.diff', 'always'], ['diff.noprefix', 'true'], ['diff.mnemonicPrefix', 'true']]) git('config', key, value);
  await writeFile(path.join(cwd, 'one.txt'), 'alpha\nbeta\n');
  await writeFile(path.join(cwd, 'two.txt'), 'gamma\n');
  git('add', '-A'); git('commit', '-q', '-m', 'first');
  await writeFile(path.join(cwd, 'one.txt'), 'alpha\nBETA needle\n');
  await writeFile(path.join(cwd, 'two.txt'), 'GAMMA\n');
  git('commit', '-q', '-am', 'second');
  const head = git('rev-parse', 'HEAD');
  assert.ok(execFileSync('git', ['show', '--format=', head], { cwd, encoding: 'utf8' }).includes('\x1b['), 'plain git show really is coloured here');

  const log = new CommandLog(root);
  await log.load();
  const plain = text => {
    assert.ok(!text.includes('\x1b'), 'no escape codes');
    assert.match(text, /^diff --git a\/\S+ b\/\S+$/m, 'a/ and b/ sides');
  };
  const commitDiff = await loadFileDiff({ cwd, log, oid: head, file: 'one.txt' });
  plain(commitDiff.patch);
  assert.match(commitDiff.patch, /^@@ -1,2 \+1,2 @@$/m, 'the hunk header is readable');
  plain((await loadFileDiff({ cwd, log, oid: head, file: 'one.txt', base: git('rev-parse', 'HEAD~1') })).patch);

  // Several files in one read: matched by path, no per-file fallback.
  const before = log.list().length;
  const commitDiffs = await loadCommitDiffs({ cwd, log, oid: head, paths: ['one.txt', 'two.txt'] });
  assert.equal(log.list().length - before, 1, 'one git show for both files');
  assert.equal(commitDiffs.get('two.txt').hunks.length, 1);

  await writeFile(path.join(cwd, 'one.txt'), 'alpha\nBETA needle\nmore\n');
  await writeFile(path.join(cwd, 'two.txt'), 'GAMMA\ndelta\n');
  plain((await loadWorktreeDiff({ cwd, log, path: 'one.txt' })).text);
  const mark = log.list().length;
  const worktreeDiffs = await loadWorktreeDiffs({ cwd, log, paths: ['one.txt', 'two.txt'] });
  assert.equal(log.list().length - mark, 1, 'one git diff for both files');
  assert.equal(worktreeDiffs.get('one.txt').hunks.length, 1);

  git('stash', 'push', '-q');
  const stash = git('rev-parse', 'stash@{0}');
  plain((await loadStashDiff({ cwd, log, oid: stash, file: 'two.txt' })).patch);

  const found = await searchCommits({ cwd, log, query: 'needle', mode: 'code', limit: 5 });
  assert.equal(found.commits.length, 1);
  assert.ok(!JSON.stringify(found.commits).includes('\\u001b'), 'search results carry no escape codes');
  assert.ok(found.commits[0].files.some(file => file.path === 'one.txt'), 'and name the file by its path');
  console.log('User config checks passed: color.diff=always, diff.noprefix and diff.mnemonicPrefix do not reach the parsers.');
} finally {
  await rm(root, { recursive: true, force: true });
}
