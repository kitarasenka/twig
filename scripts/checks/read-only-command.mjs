import assert from 'node:assert/strict';
import { checkReadOnly, READ_ONLY, tokenize } from '../../main/git/read-only-command.js';

// --- tokenizer -----------------------------------------------------------
assert.deepEqual(tokenize('log --oneline -5'), ['log', '--oneline', '-5']);
assert.deepEqual(tokenize('  git   log  '), ['log'], 'a leading git token is dropped');
assert.deepEqual(tokenize('GIT log'), ['log'], 'case-insensitive git token');
assert.deepEqual(tokenize("log --grep 'fix bug'"), ['log', '--grep', 'fix bug']);
assert.deepEqual(tokenize('show HEAD:a\\ b.txt'), ['show', 'HEAD:a b.txt']);
for (const bad of ['', '   ', 'git', 'log && rm', 'log | cat', 'log ; ls', 'log > f', 'log `id`', 'echo $HOME', 'log "open', 'log a\\']) {
  assert.throws(() => tokenize(bad), `tokenizer must reject: ${JSON.stringify(bad)}`);
}
assert.throws(() => tokenize('log\n--all'), /shell operators/);

// --- allowlist: accepted ----------------------------------------------
const allowed = [
  'log --oneline -5', 'log --graph --all', 'show HEAD', 'show -c HEAD',
  'diff main..dev -- src/app.js', 'status', 'status -sb', 'branch', 'branch -a',
  'branch -vv', 'branch --contains HEAD', 'branch --merged', 'branch --list', "branch --list 'feat/*'",
  'branch -a --points-at HEAD', 'tag', 'tag -l',
  "tag -l 'v*'", 'tag --points-at HEAD', 'remote', 'remote -v', 'remote show origin',
  'remote get-url origin', 'stash list', 'stash show -p', 'worktree list',
  'reflog', 'reflog show main', 'rev-parse HEAD', 'rev-list --count HEAD',
  'merge-base main dev', 'describe --tags', 'blame -- README.md', 'shortlog -sn',
  'for-each-ref --format=%(refname)', 'show-ref', 'ls-files', 'ls-tree -r HEAD',
  'grep -n TODO', 'symbolic-ref HEAD', 'cat-file -p HEAD', 'cat-file --textconv HEAD:a'
];
for (const command of allowed) {
  assert.deepEqual(checkReadOnly(tokenize(command)), { ok: true }, `must allow: ${command}`);
}

// --- allowlist: rejected ---------------------------------------------
const rejected = [
  'commit -m x', 'commit --amend', 'add .', 'add -A', 'restore .', 'checkout main',
  'switch -c feature', 'push', 'push --force', 'pull', 'fetch --all', 'merge dev',
  'rebase -i HEAD~3', 'reset --hard HEAD~1', 'clean -fd', 'gc', 'fsck', 'stash',
  'stash push', 'stash pop', 'stash drop', 'stash clear', 'stash branch tmp',
  'worktree add ../wt', 'worktree remove ../wt', 'reflog delete main@{0}',
  'reflog expire --all', 'branch -D old', 'branch -d old', 'branch new-branch',
  'branch -m old new', 'branch --set-upstream-to=origin/main', 'branch -f main HEAD',
  'tag v1.0', 'tag -a v1 -m msg', 'tag -d v1', 'tag -f v1', 'remote add o url',
  'remote remove o', 'remote set-url o url', 'remote prune o', 'remote update',
  'symbolic-ref HEAD refs/heads/x', 'symbolic-ref -d HEAD',
  'config user.name x', 'config --list', 'config --global --list', 'help -w', 'help',
  'difftool', 'mergetool', 'filter-branch', 'send-email', 'daemon', 'hook run pre-commit',
  'notacommand', 'log --output=/tmp/x', 'log --output /tmp/x', 'log -o /tmp/x',
  'log --ext-diff', 'grep --open-files-in-pager TODO', 'show --textconv HEAD',
  'fetch --upload-pack=/bin/sh origin', '-c core.pager=sh log', '-C /etc status',
  '--exec-path=/tmp log', '--git-dir=/tmp/x log', ''
];
for (const command of rejected) {
  const argv = command === '' ? [] : tokenize(command);
  const verdict = checkReadOnly(argv);
  assert.equal(verdict.ok, false, `must reject: ${JSON.stringify(command)}`);
  assert.equal(typeof verdict.reason, 'string');
  assert.ok(verdict.reason.length > 0, `rejection needs a reason: ${command}`);
}

// A bare non-array / empty input never throws, it is a clean rejection.
assert.equal(checkReadOnly([]).ok, false);
assert.equal(checkReadOnly(null).ok, false);
assert.ok(READ_ONLY.has('log') && !READ_ONLY.has('commit') && !READ_ONLY.has('config'));

console.log('read-only-command check passed: tokenizer, allowlist accept/reject, subcommand guards.');
