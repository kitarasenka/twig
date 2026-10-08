import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { parseNumstat, buildWorktreeNumstatArgv, buildCommitNumstatArgv } from '../../main/git/numstat.js';
import { buildCommitDiffsArgv, validateRevision } from '../../main/git/commit.js';
import { buildDiffArgv, buildDiffsArgv, buildUntrackedDiffArgv, chunkPath } from '../../main/git/worktree.js';
import { splitPatchFiles, parseFilePatchV1 } from '../../main/git/diff-parser.js';
import { TOOLS, PROTOCOL_VERSIONS, CWD_META, negotiateVersion, toolResult } from '../../main/mcp/protocol.mjs';
import { TOOL_NAMES, bindTools } from '../../main/mcp/tools/index.js';
import { validateArguments, readCursor } from '../../main/mcp/arguments.js';
import { McpError, ERROR_CODES } from '../../main/mcp/errors.js';
import { normalizeUiContext, uiContextFor } from '../../main/mcp/ui-context.js';
import { resolveEndpoint, launchCommand, clientConfigs } from '../../main/mcp/endpoint.js';
import { DIFF_BUDGET, fileLine, quotePath, hunkHeader, commitLine } from '../../main/mcp/serialize.js';
import { DID_NOT_FIT, FILE_LINE_LIMIT, fitPatches, isGeneratedPath, leftOutLine, shellWord } from '../../main/mcp/file-patches.js';
import { readCommand } from '../../main/mcp/tools/changes.js';
import { showCommand } from '../../main/mcp/tools/show.js';
import { lineMatcher, matchWindows, WINDOWS_PER_FILE } from '../../main/mcp/tools/search.js';
import { blameRuns } from '../../main/mcp/tools/blame.js';
import { buildPickaxeArgv, buildPickaxeShowArgv, parsePickaxeLog, pickaxeChunkPath } from '../../main/git/pickaxe.js';
import { buildBlameRangeArgv } from '../../main/git/blame.js';
import { summarizeWorktree } from '../../main/mcp/tools/workspace.js';
import { createMcpSession, clientCwd } from '../../main/mcp/session.js';
import { createToolContext } from '../../main/mcp/context.js';
import { createMcpService } from '../../main/mcp/service.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';
import { buildUiContext } from '../../renderer/src/features/graph/ui-context-report.js';
import { mcpStatusLine, mcpSummary, mcpToolTitle } from '../../renderer/src/features/settings/mcp-view.js';

// --- the catalog: read-only, and nothing that runs commands ----------------------------
assert.deepEqual(TOOLS.map(tool => tool.name), TOOL_NAMES, 'every catalog entry has an implementation, in the same order');
// Every tool reads, except the three that propose a commit (or a release) for the person to confirm (scripts/checks/mcp-commit.mjs).
for (const tool of TOOLS.filter(item => !['propose_commit', 'new_version', 'await_commit'].includes(item.name))) {
  assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  assert.equal(tool.annotations.destructiveHint, false, tool.name);
  assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.match(tool.name, /^(?:get|list|search)_/, `${tool.name}: every tool only reads`);
  assert.doesNotMatch(tool.name, /run|exec|shell|command|stage|checkout|reset|merge|rebase|push|delete|create/, tool.name);
}
assert.equal(negotiateVersion('2025-03-26'), '2025-03-26');
assert.equal(negotiateVersion('1999-01-01'), PROTOCOL_VERSIONS[0]);
assert.ok(ERROR_CODES.includes('NO_REPOSITORY_OPEN') && ERROR_CODES.includes('OUTPUT_TOO_LARGE'));
assert.throws(() => new McpError('SOMETHING_ELSE', 'x'), TypeError);

// --- search_history and get_blame: argv, parsing and windows, without Git -----------------
{
  const argv = buildPickaxeArgv({ query: '--output=/tmp/x', mode: 'code', limit: 11 });
  assert.ok(argv.includes('-S--output=/tmp/x'), 'the query is one token glued to its option, never an option of its own');
  assert.deepEqual(argv.slice(-3), ['--end-of-options', 'HEAD', '--']);
  assert.ok(argv.includes('--format=%H') && argv.includes('--max-count=11') && !argv.includes('-p'), 'the walk prints hashes only');
  const scoped = buildPickaxeArgv({ query: 'x', mode: 'regex', all: true, path: 'src/a b.js', limit: 5 });
  assert.deepEqual(scoped.slice(-5), ['--exclude=refs/stash', '--exclude=refs/twig/*', '--all', '--', ':(literal)src/a b.js']);
  assert.ok(scoped.includes('-Gx') && !scoped.some(arg => arg.startsWith('--skip')), 'no --skip: Git applies it before the pickaxe');
  const shown = buildPickaxeShowArgv({ query: 'x', mode: 'code', oids: ['a'.repeat(40), 'b'.repeat(40)], path: 'src', context: 0 });
  assert.equal(shown[0], 'show');
  assert.ok(shown.includes('-Sx') && shown.includes('-p') && shown.includes('--no-ext-diff') && shown.includes('--no-textconv') && shown.includes('--no-renames') && shown.includes('-U0'));
  assert.deepEqual(shown.slice(-5), ['--end-of-options', 'a'.repeat(40), 'b'.repeat(40), '--', ':(literal)src']);
  const message = buildPickaxeShowArgv({ query: 'Fix', mode: 'message', oids: ['a'.repeat(40)] });
  assert.ok(message.includes('--no-patch') && !message.includes('-p') && !message.some(arg => arg.startsWith('--grep')), 'a page of a message search is commits only');
  assert.ok(buildPickaxeArgv({ query: 'Fix', mode: 'message', limit: 5 }).includes('--grep=Fix'));
  assert.ok(buildPickaxeArgv({ query: 'ada', mode: 'author', limit: 5 }).includes('--author=ada'));
  assert.throws(() => buildPickaxeShowArgv({ query: 'x', mode: 'code', oids: ['HEAD'] }), TypeError, 'a page names commits by hash only');
  assert.throws(() => buildPickaxeShowArgv({ query: 'x', mode: 'code', oids: [] }), TypeError);
  assert.throws(() => buildPickaxeArgv({ query: 'x', mode: 'shell', limit: 5 }), TypeError);
  assert.throws(() => buildPickaxeArgv({ query: ' ', mode: 'code', limit: 5 }), TypeError);
  assert.throws(() => buildPickaxeArgv({ query: 'x', mode: 'code', limit: 5, revision: '--all' }), TypeError);
  assert.throws(() => buildPickaxeArgv({ query: 'x', mode: 'code', limit: 5, path: '../up' }), TypeError);
  assert.throws(() => buildPickaxeArgv({ query: 'x'.repeat(201), mode: 'code', limit: 5 }), TypeError);

  const oid = 'a'.repeat(40);
  const log = `\0\x01${oid}\0${'b'.repeat(40)}\0Ada\x002026-10-06T10:00:00+04:00\0Subject\n\ndiff --git a/sp ace.js b/sp ace.js\nindex 1..2 100644\n--- a/sp ace.js\t\n+++ b/sp ace.js\t\n@@ -1 +1 @@\n-old\n+new\n`
    + `\0\x01${'c'.repeat(40)}\0\0Ada\x002026-10-05T10:00:00+04:00\0Root\n`;
  const parsed = parsePickaxeLog(log);
  assert.equal(parsed.length, 2);
  assert.deepEqual([parsed[0].oid, parsed[0].parents.length, parsed[0].subject, parsed[0].files.length], [oid, 1, 'Subject', 1]);
  assert.equal(parsed[0].files[0].path, 'sp ace.js');
  assert.deepEqual(parsed[1].parents, [], 'a root commit has no parents');
  assert.throws(() => parsePickaxeLog('\0\x01nothex\0\0a\0d\0s\n'));
  assert.equal(pickaxeChunkPath('diff --git "a/\\303\\251.js" "b/\\303\\251.js"\n--- "a/\\303\\251.js"\n+++ "b/\\303\\251.js"\n'), 'é.js', 'a quoted path is unquoted');
  assert.equal(pickaxeChunkPath('diff --git a/x b/y\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n'), 'gone.txt');

  // Windows: real line numbers on both sides, merged when they touch, a count of 0 named like Git does.
  const hunk = parseFilePatchV1('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -10,8 +10,8 @@ function f()\n a\n b\n-c add(\n+c sum(\n d\n e\n f\n-g add(\n+g\n h\n').hunks[0];
  const windows = matchWindows(hunk, text => text.includes('add('), 1);
  assert.deepEqual(windows.map(item => [item.oldStart, item.oldLines, item.newStart, item.newLines, item.heading]), [[11, 2, 11, 2], [15, 2, 15, 2]].map(row => [...row, 'function f()']));
  assert.deepEqual(windows[0].lines.map(line => line.text), ['b', 'c add(', 'c sum(']);
  assert.equal(matchWindows(hunk, text => text.includes('add('), 3).length, 1, 'windows that touch merge');
  assert.deepEqual(matchWindows(hunk, () => false, 3), []);
  assert.equal(matchWindows(hunk, text => text === 'c add(' || text === 'b', 0).length, 1, 'a context line never matches by itself');
  const added = parseFilePatchV1('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+x\n+hit\n+y\n').hunks[0];
  assert.deepEqual(matchWindows(added, text => text === 'hit', 0).map(item => [item.oldStart, item.oldLines, item.newStart, item.newLines]), [[0, 0, 2, 1]]);

  // A regex from an agent runs with a deadline: one that backtracks forever marks nothing instead of freezing the app.
  assert.ok(lineMatcher('regex', 'add\\(', ['add(1)', 'sum(1)']).matches('add(1)'));
  assert.equal(lineMatcher('regex', 'add\\(', ['add(1)', 'sum(1)']).matches('sum(1)'), false);
  assert.match(lineMatcher('regex', '(', []).reason, /not one JavaScript reads/);
  const started = Date.now();
  assert.match(lineMatcher('regex', '(a+)+$', [`${'a'.repeat(40)}!`]).reason, /too slow/);
  assert.ok(Date.now() - started < 3000);
  assert.ok(lineMatcher('code', 'a.b', []).matches('xa.by') && !lineMatcher('code', 'a.b', []).matches('axb'), 'code mode is literal');

  assert.deepEqual(buildBlameRangeArgv({ path: 'a b.js' }), ['blame', '--line-porcelain', '--no-textconv', '--', 'a b.js'], 'no revision: the file on disk');
  assert.deepEqual(buildBlameRangeArgv({ oid, path: 'x', start: 5 }).slice(3), ['-L', '5,', oid, '--', 'x']);
  assert.deepEqual(buildBlameRangeArgv({ path: 'x', end: 9 }).slice(3, 5), ['-L', '1,9']);
  assert.throws(() => buildBlameRangeArgv({ path: 'x', start: 9, end: 2 }), TypeError);
  assert.throws(() => buildBlameRangeArgv({ path: '/etc/passwd' }), TypeError);
  assert.throws(() => buildBlameRangeArgv({ oid: 'HEAD', path: 'x' }), TypeError, 'a revision is resolved to an oid first');
  assert.deepEqual(blameRuns([{ oid: 'a', line: 1, content: 'x' }, { oid: 'a', line: 2, content: 'y' }, { oid: 'b', line: 3, content: 'z' }, { oid: 'a', line: 4, content: 'w' }])
    .map(run => [run.oid, run.from, run.to]), [['a', 1, 2], ['b', 3, 3], ['a', 4, 4]]);
}

// --- Git-layer readers: argv and parsers ------------------------------------------------
assert.deepEqual(buildWorktreeNumstatArgv({ staged: true }).slice(-2), ['--cached', '--']);
assert.ok(buildCommitNumstatArgv('a'.repeat(40), 'b'.repeat(40)).includes('--no-renames'));
assert.throws(() => buildCommitNumstatArgv('--all'), TypeError);
{
  const counts = parseNumstat('3\t1\tsrc/a.js\0-\t-\timg.png\0' + '0\t0\t\0old name\0new name\0' + '2\t0\tta\tb\0');
  assert.deepEqual(counts.get('src/a.js'), { path: 'src/a.js', originalPath: null, binary: false, insertions: 3, deletions: 1 });
  assert.equal(counts.get('img.png').binary, true);
  assert.equal(counts.get('img.png').insertions, null);
  assert.equal(counts.get('new name').originalPath, 'old name');
  assert.equal(counts.get('ta\tb').insertions, 2, 'a tab in a path survives -z');
  assert.equal(parseNumstat('').size, 0);
  assert.throws(() => parseNumstat('x\ty\tz\0'));
  assert.throws(() => parseNumstat('1\t1\ta'), 'unterminated');
}
for (const ok of ['HEAD', 'HEAD~2', 'HEAD^', 'main', 'feature/x', 'origin/main', 'v1.2', 'abc1234', 'a'.repeat(40), 'HEAD~1^2']) assert.equal(validateRevision(ok), ok);
for (const bad of ['--all', '-p', 'a..b', 'HEAD@{1}', 'a b', '', ':/msg', 'x:y', '../x', 'a\0b', 'x.lock', '.hidden', 42, null]) assert.throws(() => validateRevision(bad), TypeError, String(bad));
{
  const oid = 'a'.repeat(40);
  const argv = buildCommitDiffsArgv({ oid, paths: ['a', '-b'], context: 1 });
  assert.equal(argv[0], 'show');
  assert.ok(['--first-parent', '--no-renames', '--no-ext-diff', '--no-textconv', '--unified=1'].every(flag => argv.includes(flag)));
  assert.deepEqual(argv.slice(-4), [oid, '--', ':(literal)a', ':(literal)-b'], 'paths are literal and after --');
  assert.ok(!buildCommitDiffsArgv({ oid, paths: ['a'] }).some(arg => arg.startsWith('--unified')));
  assert.throws(() => buildCommitDiffsArgv({ oid: 'HEAD', paths: ['a'] }), TypeError, 'a revision is resolved to an oid first');
  assert.throws(() => buildCommitDiffsArgv({ oid, paths: [] }), TypeError);
  assert.throws(() => buildCommitDiffsArgv({ oid, paths: ['../x'] }), TypeError);
  assert.throws(() => buildCommitDiffsArgv({ oid, paths: ['a'], context: -1 }), TypeError);
}
assert.ok(buildDiffArgv({ path: 'a', context: 0 }).includes('--unified=0'));
assert.ok(!buildDiffArgv({ path: 'a' }).some(arg => arg.startsWith('--unified')), 'staging keeps Git’s default context');
assert.throws(() => buildDiffArgv({ path: 'a', context: -1 }), TypeError);
assert.deepEqual(buildUntrackedDiffArgv({ path: 'n.txt' }).slice(-3), ['--', '/dev/null', 'n.txt']);
assert.deepEqual(buildDiffsArgv({ paths: ['a', '-b'], staged: true, context: 1 }).slice(-4), ['--cached', '--', ':(literal)a', ':(literal)-b']);
assert.throws(() => buildDiffsArgv({ paths: [] }), TypeError);
assert.throws(() => buildDiffsArgv({ paths: ['../x'] }), TypeError);
assert.equal(chunkPath('diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n'), 'src/a.js');
assert.equal(chunkPath('diff --git a/a b/a b/a b/a\n'), 'a b/a', 'a path containing " b/" is still read by length');
assert.equal(chunkPath('diff --git "a/q\\"x" "b/q\\"x"\n'), null, 'a quoted header is not guessed at');
assert.equal(chunkPath('diff --git a/x b/y\n'), null);
assert.ok(buildUntrackedDiffArgv({ path: 'n.txt' }).includes('--no-index'));
{
  const patch = 'diff --git a/a b/a\nindex 1..2 100644\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\nnew file mode 100644\n--- /dev/null\n+++ b/b\n@@ -0,0 +1,2 @@\n+1\n+\n';
  const chunks = splitPatchFiles(patch);
  assert.equal(chunks.length, 2);
  assert.equal(parseFilePatchV1(chunks[0]).hunks[0].lines.length, 2);
  assert.equal(parseFilePatchV1(chunks[1]).hunks[0].newLines, 2, 'an empty last line is content, not the final newline');
  assert.deepEqual(splitPatchFiles(''), []);
  assert.throws(() => splitPatchFiles('garbage\n'));
}

// --- arguments, cursors and budgets -------------------------------------------------------
{
  const schema = TOOLS.find(tool => tool.name === 'get_commit').inputSchema;
  assert.deepEqual(validateArguments(schema, { hash: 'HEAD' }), { hash: 'HEAD', diffs: true, contextLines: 3, maxBytes: 60000 });
  assert.deepEqual(validateArguments(TOOLS.find(tool => tool.name === 'list_changes').inputSchema, {}), { diffs: false, contextLines: 3, maxBytes: 60000, limit: 200 });
  for (const bad of [{}, { hash: 1 }, { hash: 'a', extra: 1 }, { hash: 'a', contextLines: 99 }, { hash: 'a', contextLines: 1.5 }, { hash: 'a', maxBytes: 10 }, { hash: 'a\0' }, []]) {
    assert.throws(() => validateArguments(schema, bad), error => error.code === 'INVALID_ARGUMENT', JSON.stringify(bad));
  }
  const search = TOOLS.find(tool => tool.name === 'search_history').inputSchema;
  assert.equal(validateArguments(search, { query: 'x', branch: null }).branch, null, 'a nullable argument accepts null');
  assert.equal(readCursor(undefined), 0);
  assert.equal(readCursor('40'), 40);
  assert.throws(() => readCursor('-1'), error => error.code === 'INVALID_ARGUMENT');
}
{
  // Patches share one answer smallest first; a file is whole or a note with the command that reads it.
  const patch = lines => ({ hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines, lines: Array.from({ length: lines }, () => ({ kind: 'add', text: 'x'.repeat(30) })) }] });
  const entries = [{ path: 'big', patch: patch(10) }, { path: 'small', patch: patch(1) }, { path: 'mid', patch: patch(3) }, { path: 'lock', note: 'kept' }];
  fitPatches(entries, 200, entry => `git diff -- ${entry.path}`);
  assert.deepEqual(entries.map(entry => Boolean(entry.text)), [false, true, true, false]);
  assert.equal(entries[0].note, 'did not fit in this answer: git diff -- big');
  assert.equal(entries[3].note, 'kept', 'a note set before is kept');
  const batched = [{ path: 'a b', patch: patch(10) }, { path: 'c', patch: patch(10) }, { path: 'd', patch: patch(1) }];
  fitPatches(batched, 100);
  assert.deepEqual(batched.map(entry => entry.note ?? null), [DID_NOT_FIT, DID_NOT_FIT, null], 'with no command of its own, a file waits for the one at the end');
  assert.equal(leftOutLine(batched, paths => `git diff -- ${paths.map(shellWord).join(' ')}`), "Did not fit, all in one call: git diff -- 'a b' c");
  assert.equal(leftOutLine(batched.slice(2), () => 'x'), null);
  const empty = [{ path: 'm', patch: { hunks: [], mode: true } }, { path: 'r', originalPath: 'o', patch: { hunks: [] } }];
  fitPatches(empty, 100, () => '');
  assert.deepEqual(empty.map(entry => entry.note), ['mode change only', 'renamed, content unchanged']);

  // The commands a note prints: one shell word per path, the side, the context asked for.
  assert.equal(shellWord('src/a-b_c.js'), 'src/a-b_c.js');
  assert.equal(shellWord("it's a file.txt"), `'it'\\''s a file.txt'`);
  assert.equal(shellWord('$(rm -rf ~)'), "'$(rm -rf ~)'", 'nothing in a path runs if the command is pasted');
  assert.equal(readCommand({ side: 'unstaged', path: 'a b.js' }, 3), "git diff -- 'a b.js'");
  assert.equal(readCommand({ side: 'staged', path: 'a.js' }, 1), 'git diff --cached -U1 -- a.js');
  assert.equal(readCommand({ side: 'staged', path: 'new.js', originalPath: 'old.js' }, 3), 'git diff --cached -M -- old.js new.js');
  assert.equal(readCommand({ side: 'untracked', path: 'n.txt' }, 3), 'read the file itself');
  const commit = { oid: 'c'.repeat(40), parents: ['a'.repeat(40)] };
  assert.equal(showCommand(commit, ['package-lock.json'], 3), `git show --format= ${'c'.repeat(12)} -- package-lock.json`);
  assert.equal(showCommand({ ...commit, parents: [...commit.parents, 'b'.repeat(40)] }, ['x', 'y z'], 0), `git show --format= --first-parent -U0 ${'c'.repeat(12)} -- x 'y z'`,
    'a merge is read against its first parent, as get_commit shows it');
}
{
  // Text answers: git's own shapes, one token per path.
  assert.equal(fileLine({ letter: 'M', path: 'src/a.js', insertions: 2, deletions: 1 }), 'M +2 -1 src/a.js');
  assert.equal(fileLine({ letter: 'R', path: 'new.js', originalPath: 'old.js', insertions: 0, deletions: 0 }), 'R +0 -0 old.js -> new.js');
  assert.equal(fileLine({ letter: 'M', path: 'logo.png', insertions: null, deletions: null, binary: true }), 'M bin logo.png');
  assert.equal(fileLine({ letter: '?', path: 'notes.txt' }), '? notes.txt', 'unknown counts are left out, not printed as null');
  assert.equal(quotePath('with space.txt'), 'with space.txt');
  for (const odd of ['tab\there', 'quote"d', ' lead', 'trail ', 'a -> b', 'new\nline']) assert.equal(quotePath(odd), JSON.stringify(odd), odd);
  assert.equal(hunkHeader({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, heading: 'fn x' }), '@@ -1 +1,3 @@ fn x', 'a count of one is left out, as Git does');
  assert.equal(hunkHeader({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }), '@@ -0,0 +1,2 @@');
  const oid = 'c'.repeat(40);
  assert.equal(commitLine({ oid, parents: ['a'.repeat(40), 'b'.repeat(40)], subject: 'Merge x', author: { name: 'Ada', date: '2026-10-06T10:00:00+04:00' } }),
    `${'c'.repeat(12)} 2026-10-06 Ada: Merge x (merge of ${'a'.repeat(12)}, ${'b'.repeat(12)})`);
  for (const name of ['package-lock.json', 'apps/web/yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'dist/app.min.js', 'x.css.map']) assert.ok(isGeneratedPath(name), name);
  for (const name of ['src/lock.js', 'package.json', 'docs/lockfile.md', 'admin.js']) assert.ok(!isGeneratedPath(name), name);
  assert.deepEqual(toolResult('plain\n').content, [{ type: 'text', text: 'plain\n' }], 'text goes out as it is, not as a JSON string');
  assert.equal(clientCwd({ _meta: { [CWD_META]: '/Users/me/project/' } }), '/Users/me/project');
  for (const bad of [undefined, {}, { _meta: { [CWD_META]: 'relative/dir' } }, { _meta: { [CWD_META]: 5 } }, { _meta: { [CWD_META]: '/a\0b' } }]) assert.equal(clientCwd(bad), null);
}
{
  const file = (path, status) => ({ path, status, originalPath: null, submodule: false });
  assert.deepEqual(summarizeWorktree({ staged: [], unstaged: [], untracked: [] }).clean, true);
  const counts = summarizeWorktree({ staged: [file('a', 'A'), file('b', 'M')], unstaged: [file('b', 'M'), file('c', 'D'), file('d', 'U')], untracked: [file('e/', '?')] });
  assert.deepEqual(counts, { clean: false, staged: 2, unstaged: 2, untracked: 1, conflicts: 1, modified: 1, added: 1, deleted: 1, renamed: 0 });
}

// --- UI context reports -------------------------------------------------------------------
{
  const oid = 'a'.repeat(40);
  const good = normalizeUiContext({ repositoryId: '/r', view: 'history', selectedCommit: oid, selectedCommits: [oid], compare: null,
    selectedFile: { path: 'src/a.js', commit: oid, side: null } });
  assert.equal(good.selectedFile.path, 'src/a.js');
  assert.equal(uiContextFor(good, '/r'), good);
  assert.equal(uiContextFor(good, '/other'), null, 'a report about another repository is not used');
  for (const bad of [null, [], { repositoryId: 5 }, { repositoryId: '/r', view: 'settings' }, { repositoryId: '/r', selectedCommit: 'HEAD' },
    { repositoryId: '/r', selectedFile: { path: '' } }, { repositoryId: '/r', selectedFile: { path: 'a', side: 'both' } },
    { repositoryId: '/r', selectedCommits: Array(101).fill(oid) }, { repositoryId: '/r', compare: { base: oid } }]) {
    assert.equal(normalizeUiContext(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.equal(normalizeUiContext({ repositoryId: null, view: 'history' }).view, null, 'no repository, no view');
}

// --- endpoint and client configuration ----------------------------------------------------
{
  const short = resolveEndpoint({ userData: '/Users/me/Library/Application Support/twig', platform: 'darwin', tmpdir: '/tmp/t' });
  assert.equal(short.socket, '/Users/me/Library/Application Support/twig/mcp/twig.sock');
  const long = resolveEndpoint({ userData: `/Users/${'x'.repeat(90)}/twig`, platform: 'linux', tmpdir: '/tmp/t' });
  assert.match(long.socket, /^\/tmp\/t\/twig-mcp-[0-9a-f]{16}\/twig\.sock$/, 'a socket path past sockaddr_un falls back to the temp folder');
  assert.equal(long.dir, `/Users/${'x'.repeat(90)}/twig/mcp`, 'the bridge files stay in userData');
  assert.match(resolveEndpoint({ userData: 'C:\\Users\\me\\twig', platform: 'win32' }).socket, /^\\\\\.\\pipe\\twig-mcp-[0-9a-f]{16}$/);
  const launch = launchCommand({ execPath: '/Applications/🌱 Twig.app/Contents/MacOS/🌱 Twig', dir: "/Users/o'neil/Library/Application Support/twig/mcp" });
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1');
  const configs = clientConfigs(launch, 'darwin');
  assert.equal(configs.claude, "claude mcp add --scope user twig --env ELECTRON_RUN_AS_NODE=1 -- '/Applications/🌱 Twig.app/Contents/MacOS/🌱 Twig' '/Users/o'\\''neil/Library/Application Support/twig/mcp/twig-mcp.mjs'");
  assert.deepEqual(JSON.parse(configs.json).mcpServers.twig, launch);
  assert.match(configs.codex, /^\[mcp_servers\.twig\]\ncommand = "\/Applications\/🌱 Twig\.app\/Contents\/MacOS\/🌱 Twig"\nargs = \["\/Users\/o'neil\/Library\/Application Support\/twig\/mcp\/twig-mcp\.mjs"\]\nenv = \{ ELECTRON_RUN_AS_NODE = "1" \}$/);
  assert.equal(launchCommand({ execPath: '/tmp/.mount_x/twig.bin', appImage: '/home/me/Twig.AppImage', dir: '/d' }).command, '/home/me/Twig.AppImage',
    'an AppImage is started through its stable path, not the mount');
  assert.match(clientConfigs(launchCommand({ execPath: 'C:\\Program Files\\Twig\\Twig.exe', dir: 'C:\\d' }), 'win32').claude, / -- "C:\\Program Files\\Twig\\Twig\.exe" /);
}
assert.equal(isUserCommand('MCP: Read working tree'), false, 'agent reads are not the person’s own commands');

// --- what the window reports, and the Settings words ---------------------------------------
{
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const base = { repositoryId: '/r', selected: a, selection: [], range: null, diff: null, fileHistory: null, blame: null, conflict: null, screen: null, uncommitted: false };
  const report = state => { const value = buildUiContext({ ...base, ...state }); assert.ok(normalizeUiContext(value), `main accepts ${JSON.stringify(value)}`); return value; };
  assert.deepEqual(report({}), { repositoryId: '/r', view: 'history', selectedCommit: a, selectedCommits: [], compare: null, selectedFile: null });
  assert.deepEqual(report({ diff: { file: 'x.js' } }).selectedFile, { path: 'x.js', commit: a, side: null }, 'a file in the commit panel belongs to that commit');
  assert.deepEqual(report({ selected: 'uncommitted', uncommitted: true, diff: { file: 'x.js', section: 'staged' } }),
    { repositoryId: '/r', view: 'changes', selectedCommit: null, selectedCommits: [], compare: null, selectedFile: { path: 'x.js', commit: null, side: 'staged' } });
  assert.equal(report({ selected: 'worktree', screen: 'worktree' }).view, 'staging');
  assert.equal(report({ selected: 'branches', screen: 'branches', diff: { file: 'x' } }).selectedFile, null, 'a screen hides the diff');
  assert.deepEqual(report({ range: { base: b, oid: a } }).compare, { base: b, target: a });
  assert.equal(report({ range: { base: b, oid: a } }).view, 'compare');
  assert.deepEqual(report({ selection: [a, b, 'nope'] }).selectedCommits, [a, b]);
  assert.deepEqual(report({ blame: { path: 'y.js', oid: b } }).selectedFile, { path: 'y.js', commit: b, side: null });
  assert.equal(report({ blame: { path: 'y.js', oid: 'abc1234' } }).selectedFile.commit, null, 'a short id is not passed on as a commit');
  assert.deepEqual(report({ conflict: 'c.txt', diff: { file: 'x' } }), { ...report({}), view: 'conflict', selectedFile: { path: 'c.txt', commit: null, side: null } });
  assert.equal(report({ fileHistory: { path: 'h.js' } }).view, 'file-history');
}
assert.equal(mcpStatusLine({ enabled: false, listening: false, error: null }), '');
assert.equal(mcpStatusLine({ enabled: true, listening: true, connections: 0, calls: 0 }), 'Listening. No agent connected yet.');
assert.equal(mcpStatusLine({ enabled: true, listening: true, connections: 2, calls: 1 }), 'Listening. 2 agents connected · 1 request answered this session.');
assert.match(mcpStatusLine({ enabled: true, listening: false, error: 'EACCES' }), /EACCES/);
assert.match(mcpSummary({ enabled: false, status: {} }), /^Off/);
assert.match(mcpSummary({ enabled: true, status: {} }), /^On/);
assert.match(mcpToolTitle(null), /^MCP: off/, 'before settings load the button still names itself');
assert.match(mcpToolTitle({ enabled: true, status: {} }), /^MCP: on/, 'on is said in words, not only by the dot');
assert.match(mcpToolTitle({ enabled: true, status: { error: 'x' } }), /could not start/);

// --- real repositories, through the JSON-RPC session ---------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-mcp-'));
try {
  const log = new CommandLog(root); await log.load();
  const repos = [];
  let activeId = null;
  let ui = null;
  const repositories = { snapshot: () => ({ repositories: repos }) };
  const ctx = createToolContext({ repositories, journal: log, getActiveId: () => activeId, getUiContext: () => ui });
  const session = createMcpSession({ version: '9.9.9', tools: bindTools(ctx) });
  let nextId = 1;
  // Errors and the small state answers are JSON; lists and diffs are plain text.
  const decode = result => {
    const raw = result.content[0].text;
    if (result.isError) return { error: JSON.parse(raw).error };
    try { return JSON.parse(raw); } catch { return raw; }
  };
  async function call(name, args = {}, on = session) {
    const response = await on.handle({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    assert.ok(response.result, JSON.stringify(response));
    return decode(response.result);
  }
  // A session whose client was started in `cwd`, as the bridge reports it.
  async function sessionIn(cwd) {
    const next = createMcpSession({ version: '9.9.9', tools: bindTools(ctx) });
    await next.handle({ jsonrpc: '2.0', id: 'i', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, _meta: { [CWD_META]: cwd } } });
    return next;
  }
  /** The file lines of a list_changes answer, by section: { staged: [...], unstaged: [...], untracked: [...] }. */
  function sections(text) {
    const result = {};
    let current = null;
    for (const line of text.split('\n')) {
      const header = /^(staged|unstaged|untracked):$/.exec(line);
      if (header) { current = result[header[1]] = []; continue; }
      if (current && line.startsWith('## ')) current.push(line.slice(3));
      else if (current && /^[MADRCTU?] /.test(line)) current.push(line);
    }
    return result;
  }
  async function expectError(code, name, args) {
    const result = await call(name, args);
    assert.equal(result.error?.code, code, `${name} ${JSON.stringify(args)} → ${JSON.stringify(result)}`);
    return result.error;
  }

  async function repository(name) {
    const cwd = path.join(root, name);
    await mkdir(cwd);
    const git = async (...argv) => { const result = await runGit({ cwd, log, argv }); assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`); return result.stdout; };
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Ada Lovelace');
    await git('config', 'user.email', 'ada@example.com');
    await git('config', 'commit.gpgSign', 'false');
    const write = async (file, text) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), text); };
    const commit = async (message, files) => { for (const [file, text] of Object.entries(files)) await write(file, text); await git('add', '-A'); await git('commit', '-q', '-m', message); return (await git('rev-parse', 'HEAD')).trim(); };
    repos.push({ id: cwd, name, path: cwd, available: true });
    return { cwd, git, write, commit };
  }

  // Protocol basics: initialize negotiates, tools/list is the catalog, unknown things are refused.
  {
    const init = await session.handle({ jsonrpc: '2.0', id: 'i', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'check', version: '1' } } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal(init.result.serverInfo.version, '9.9.9');
    assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
    assert.equal(await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'notifications get no answer');
    assert.equal((await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, TOOLS.length);
    assert.equal((await session.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run_command', arguments: {} } })).error.code, -32602);
    assert.equal((await session.handle({ jsonrpc: '2.0', id: 4, method: 'resources/list' })).error.code, -32601);
    assert.equal((await session.handleLine('{not json')).error.code, -32700);
    assert.deepEqual((await session.handle({ jsonrpc: '2.0', id: 5, method: 'ping' })).result, {});
  }

  // 11. No repository open.
  // get_workspace_context still answers, with the reason and the connected repositories: it is how an agent finds one.
  {
    const none = await call('get_workspace_context');
    assert.equal(none.repository, null);
    assert.match(none.reason, /No repository is currently open/);
    assert.deepEqual(none.repositories, []);
  }
  await expectError('NO_REPOSITORY_OPEN', 'list_changes');
  await expectError('NO_REPOSITORY_OPEN', 'get_commit', { hash: 'HEAD' });
  await expectError('REPOSITORY_NOT_FOUND', 'get_workspace_context', { repository: 'nothing-here' });
  assert.deepEqual(await call('get_ui_context'), { repository: null, view: null, selectedBranch: null, selectedCommit: null, selectedCommits: [], compare: null, selectedFile: null, selectedHunk: null });

  const main = await repository('alpha');
  const first = await main.commit('Initial commit', { 'README.md': '# Alpha\n', 'src/app.js': 'export const one = 1;\n', 'docs/guide.md': 'Read me.\n' });
  activeId = main.cwd;

  // 1. Clean repository.
  {
    const context = await call('get_workspace_context');
    assert.equal(context.repository.path, main.cwd);
    assert.equal(context.repository.openInTwig, true);
    assert.equal(context.branch.name, 'main');
    assert.equal(context.branch.head, first.slice(0, 12));
    assert.equal(context.branch.upstream, null);
    assert.equal(context.branch.ahead, null, 'no upstream, no ahead count');
    assert.equal(context.operation, null);
    assert.equal(context.workingTree.clean, true);
    assert.equal(context.selection, null);
    assert.deepEqual(context.repositories, [], 'no other repository is connected');
    assert.ok(JSON.stringify(context).length < 800, 'the workspace summary stays small');
    assert.equal(await call('list_changes'), `repository: ${main.cwd}\non main: no changes\n`, 'a guessed repository is named first');
    assert.equal(await call('list_changes', { repository: main.cwd }), 'on main: no changes\n', 'a named one is not repeated back');
  }

  // Read-only: the whole .git folder and the working tree are byte-for-byte the same after every tool ran.
  async function fingerprint(dir) {
    const hash = createHash('sha256');
    async function walk(current) {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const info = await lstat(full);
          hash.update(`${path.relative(dir, full)}\0${info.size}\0${info.mtimeMs}\0`);
          if (entry.isFile()) hash.update(await readFile(full));
        }
      }
    }
    await walk(dir);
    return hash.digest('hex');
  }

  // 2. Modified files; 3. staged + unstaged; 4. untracked.
  await main.write('src/app.js', 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n');
  await main.write('README.md', '# Alpha\n\nStaged line.\n');
  await main.git('add', 'README.md');
  await main.write('README.md', '# Alpha\n\nStaged line.\nUnstaged line.\n');
  await main.write('notes/todo.txt', 'one\ntwo\n');
  await main.git('rm', '-q', 'docs/guide.md');
  {
    const before = await fingerprint(main.cwd);
    const context = await call('get_workspace_context');
    assert.deepEqual(context.workingTree, { clean: false, staged: 2, unstaged: 2, untracked: 1, conflicts: 0, modified: 2, added: 0, deleted: 1, renamed: 0 });

    const changes = await call('list_changes', { repository: main.cwd });
    assert.equal(changes.split('\n')[0], 'on main: 2 staged, 2 unstaged, 1 untracked');
    assert.deepEqual(sections(changes), {
      staged: ['M +2 -0 README.md', 'D +0 -1 docs/guide.md'],
      unstaged: ['M +1 -0 README.md', 'M +2 -0 src/app.js'],
      untracked: ['? notes/todo.txt']
    }, 'the same file on both sides; untracked without counts');
    const paged = await call('list_changes', { repository: main.cwd, limit: 2 });
    assert.equal(Object.values(sections(paged)).flat().length, 2);
    assert.match(paged, /… 3 more: list_changes with cursor "2"\n$/);
    const rest = await call('list_changes', { repository: main.cwd, limit: 10, cursor: '2' });
    assert.equal(Object.values(sections(rest)).flat().length, 3);
    assert.doesNotMatch(rest, /more:/);

    // One call for everything: list_changes with diffs is the same list with each patch under its line.
    const all = await call('list_changes', { repository: main.cwd, diffs: true });
    assert.deepEqual(sections(all), { ...sections(changes), untracked: ['? +2 -0 notes/todo.txt'] }, 'the same file lines, and an untracked file gets its count once read');
    const side = (text, name) => {
      const from = text.indexOf(`\n${name}:\n`) + name.length + 3;
      const next = /\n(?:staged|unstaged|untracked):\n/.exec(text.slice(from));
      return text.slice(from, next ? from + next.index + 1 : text.length);
    };
    assert.ok(side(all, 'staged').includes('## M +2 -0 README.md\n@@ -1 +1,3 @@\n # Alpha\n+\n+Staged line.\n'), 'the staged side is the index against HEAD');
    assert.ok(side(all, 'unstaged').includes('## M +1 -0 README.md\n@@ -1,3 +1,4 @@\n # Alpha\n \n Staged line.\n+Unstaged line.\n'), 'the unstaged side is the disk against the index');
    assert.ok(all.includes('## M +2 -0 src/app.js\n@@ -1 +1,3 @@\n export const one = 1;\n+export const two = 2;\n+export const three = 3;\n'));
    assert.ok(all.includes('## ? +2 -0 notes/todo.txt\n@@ -0,0 +1,2 @@\n+one\n+two'));
    assert.ok(all.includes('## D +0 -1 docs/guide.md\n@@ -1 +0,0 @@\n-Read me.'));
    const tight = await call('list_changes', { repository: main.cwd, diffs: true, contextLines: 0 });
    assert.ok(tight.includes('## M +2 -0 src/app.js\n@@ -1,0 +2,2 @@ export const one = 1;\n+export const two = 2;\n+export const three = 3;\n'), `no context lines asked for, none given\n${tight}`);
    const reads = log.list().filter(entry => entry.operation === 'MCP: Read working tree diffs' || entry.operation === 'MCP: Read staged diffs').length;
    await call('list_changes', { repository: main.cwd, diffs: true });
    assert.equal(log.list().filter(entry => entry.operation === 'MCP: Read working tree diffs' || entry.operation === 'MCP: Read staged diffs').length - reads, 2,
      'tracked files are read with one git diff per side, not one per file');

    // Repository selection by path inside it, and refusal of anything not connected.
    assert.equal((await call('get_workspace_context', { repository: path.join(main.cwd, 'src') })).repository.name, 'alpha');
    assert.match(await call('list_changes', { repository: 'alpha' }), /^on main: 2 staged/);
    await expectError('REPOSITORY_NOT_FOUND', 'list_changes', { repository: os.tmpdir() });
    await expectError('REPOSITORY_NOT_FOUND', 'list_changes', { repository: 'beta' });

    // Commits read nothing from the working tree.
    await call('get_commit', { hash: 'HEAD' });
    await call('get_commit', { hash: 'HEAD', diffs: false });
    assert.equal(await fingerprint(main.cwd), before, 'no tool changed a byte in .git or the working tree');
    assert.ok(log.list().filter(entry => entry.operation.startsWith('MCP: ')).length > 20, 'agent reads are in the journal, marked MCP');
    // Against git (after the fingerprint: git status itself rewrites the index's stat cache): what the agent would run for the same picture,, in less room.
    const gitView = (await main.git('status')) + (await main.git('diff', '--cached')) + (await main.git('diff')) + (await readFile(path.join(main.cwd, 'notes/todo.txt'), 'utf8'));
    assert.ok(all.length < gitView.length, `list_changes with diffs is ${all.length} chars, git status + git diff ×2 + cat ${gitView.length}`);

    await main.write('src/app.js', 'export const one = 1;\nexport const two = 22;\n');
  }
  await main.git('add', '-A');
  await main.git('commit', '-q', '-m', 'Second commit\n\nWith a body that explains it.');

  // 9. get_commit: the message and every file with its patch, in one call.
  {
    const at = { repository: main.cwd };
    const secondOid = (await main.git('rev-parse', 'HEAD')).trim();
    const second = secondOid.slice(0, 12);
    const commit = await call('get_commit', { ...at, hash: second.slice(0, 9) });
    const [title, authorLine, parentsLine] = commit.split('\n');
    assert.equal(title, `${secondOid} Second commit`);
    assert.match(authorLine, /^author: Ada Lovelace <ada@example\.com> \d{4}-/);
    assert.equal(parentsLine, `parents: ${first.slice(0, 12)}`);
    assert.ok(commit.includes('\n\nWith a body that explains it.\n\n4 files, +6 -1:\n'));
    assert.deepEqual(commit.split('\n').filter(line => line.startsWith('## ')).map(line => line.split(' ').at(-1)), ['README.md', 'docs/guide.md', 'notes/todo.txt', 'src/app.js']);
    assert.ok(commit.includes('## A +2 -0 notes/todo.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n'));
    assert.ok(commit.includes('## D +0 -1 docs/guide.md\n@@ -1 +0,0 @@\n-Read me.\n'));
    assert.ok(commit.endsWith('## M +1 -0 src/app.js\n@@ -1 +1,2 @@\n export const one = 1;\n+export const two = 22;\n'));
    const shown = await main.git('show', secondOid);
    assert.ok(commit.length < shown.length, `get_commit is ${commit.length} chars, git show ${shown.length}`);
    const reads = log.list().filter(entry => entry.operation === 'MCP: Read commit diff').length;
    await call('get_commit', { ...at, hash: secondOid });
    assert.equal(log.list().filter(entry => entry.operation === 'MCP: Read commit diff').length - reads, 1, 'one git show for every file of the commit');

    const tight = await call('get_commit', { ...at, hash: secondOid, contextLines: 0 });
    assert.ok(tight.endsWith('## M +1 -0 src/app.js\n@@ -1,0 +2 @@ export const one = 1;\n+export const two = 22;\n'));
    const files = await call('get_commit', { ...at, hash: secondOid, diffs: false });
    assert.ok(files.endsWith('4 files, +6 -1:\nM +3 -0 README.md\nD +0 -1 docs/guide.md\nA +2 -0 notes/todo.txt\nM +1 -0 src/app.js\n'), files);
    assert.ok(!files.includes('@@'), 'diffs: false lists the files only');
    const root = await call('get_commit', { ...at, hash: first });
    assert.ok(root.includes('\nparents: none (root commit)\n') && root.includes('## A +1 -0 README.md\n@@ -0,0 +1 @@\n+# Alpha\n'), 'a root commit against nothing');

    // 8. nonexistent commit.
    await expectError('COMMIT_NOT_FOUND', 'get_commit', { hash: 'deadbeefdeadbeef' });
    await expectError('COMMIT_NOT_FOUND', 'get_commit', { hash: 'v9.9.9' });
    await expectError('INVALID_ARGUMENT', 'get_commit', { hash: '--output=/tmp/x' });

    // Lock files and files over the line limit are listed with the git show that reads them; their content is not read.
    const rows = Array.from({ length: FILE_LINE_LIMIT + 1 }, (_, i) => `row ${i}`).join('\n') + '\n';
    const generated = await main.commit('Generated and large', { 'package-lock.json': '{"lockfileVersion":3}\n', 'vendor/huge.js': rows, 'src/small.js': 'export const small = true;\n' });
    const mixed = await call('get_commit', { ...at, hash: generated });
    const short = generated.slice(0, 12);
    assert.ok(mixed.includes(`## A +1 -0 package-lock.json\n(lock or generated file: git show --format= ${short} -- package-lock.json)`), mixed);
    assert.ok(mixed.includes(`## A +${FILE_LINE_LIMIT + 1} -0 vendor/huge.js\n(over ${FILE_LINE_LIMIT} changed lines: git show --format= ${short} -- vendor/huge.js)`));
    assert.ok(mixed.includes('## A +1 -0 src/small.js\n@@ -0,0 +1 @@\n+export const small = true;\n'));
    assert.doesNotMatch(mixed, /lockfileVersion|row 400/);

    // maxBytes: smallest files first, the rest named with their command; every file keeps its line.
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pack/f${String(i).padStart(2, '0')}.txt`, `${'y'.repeat(60)}\n`.repeat(30 + i)]));
    const bulk = await main.commit('Bulk files', many);
    const fitted = await call('get_commit', { ...at, hash: bulk, maxBytes: 20000 });
    assert.ok(Buffer.byteLength(fitted) <= 20000, `${Buffer.byteLength(fitted)}`);
    const blocks = [...fitted.matchAll(/^## A \+\d+ -0 pack\/f(\d\d)\.txt\n(.*)$/gm)].map(match => ({ number: Number(match[1]), next: match[2] }));
    const inlined = blocks.filter(block => block.next.startsWith('@@')).map(block => block.number);
    const left = blocks.filter(block => block.next === '(did not fit in this answer)').map(block => block.number);
    assert.equal(inlined.length + left.length, 30, fitted.slice(0, 1500));
    assert.ok(fitted.endsWith(`\nDid not fit, all in one call: git show --format= ${bulk.slice(0, 12)} -- ${left.map(number => `pack/f${String(number).padStart(2, '0')}.txt`).join(' ')}\n`),
      'what did not fit is read with one more call, not one per file');
    assert.ok(inlined.length > 0 && left.length > 0 && Math.max(...inlined) < Math.min(...left), `smallest first — ${inlined} / ${left}`);

    // A merge is shown against its first parent, and says so.
    await main.git('checkout', '-q', '-b', 'side', first);
    const sideCommit = await main.commit('Side work', { 'side.txt': 'from the side\n' });
    await main.git('checkout', '-q', 'main');
    await main.git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
    const merge = await call('get_commit', { ...at, hash: 'HEAD' });
    assert.match(merge, new RegExp(`\\nparents: [0-9a-f]{12} ${sideCommit.slice(0, 12)}\\n`));
    assert.ok(merge.includes('1 file, +1 -0 against the first parent:\n## A +1 -0 side.txt\n@@ -0,0 +1 @@\n+from the side\n'), merge);
  }

  // 6. A file over the line limit is listed by list_changes with the git diff that reads it.
  {
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    await main.commit('Large file', { 'big.txt': lines.join('\n') + '\n' });
    await main.write('big.txt', lines.map((line, i) => (i % 20 === 0 ? `${line} changed` : line)).join('\n') + '\n');
    const listed = await call('list_changes', { repository: main.cwd, diffs: true });
    assert.ok(listed.includes(`## M +300 -300 big.txt\n(over ${FILE_LINE_LIMIT} changed lines: git diff -- big.txt)`), listed);
    assert.ok(listed.length < 1000);
    await main.git('checkout', '--', 'big.txt');
  }

  // list_changes with diffs on a mixed tree: what is inlined, what is only listed and why, and what it costs next to git.
  {
    await main.commit('Mixed base', { 'package-lock.json': '{}\n', 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0]), 'old name.txt': 'same\n', 'tab\there.txt': 'a\n', 'with space.txt': 'a\n' });
    await main.write('package-lock.json', '{"lockfileVersion":3}\n');
    await main.write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 0]));
    await main.git('mv', 'old name.txt', 'new name.txt');
    await main.write('tab\there.txt', 'b\n');
    await main.write('with space.txt', 'b\n');
    await main.write('src/app.js', 'export const one = 1;\nexport const four = 4;\n');
    await main.write('new/blob.bin', Buffer.from([0, 1, 2, 3]));
    const answer = await call('list_changes', { repository: main.cwd, diffs: true, contextLines: 1 });
    assert.ok(answer.includes('## R +0 -0 "old name.txt" -> "new name.txt"') || answer.includes('## R +0 -0 old name.txt -> new name.txt'));
    assert.ok(answer.includes('## M +1 -1 package-lock.json\n(lock or generated file: git diff -U1 -- package-lock.json)'), 'the command keeps the context asked for');
    assert.ok(/## R \+0 -0 (?:"old name.txt"|old name.txt) -> (?:"new name.txt"|new name.txt)\n\(renamed, content unchanged\)/.test(answer));
    assert.ok(answer.includes('## M bin logo.png\n'), 'a binary file is its line, no patch');
    assert.ok(answer.includes('## M +1 -1 with space.txt\n@@ -1 +1 @@\n-a\n+b'), 'a name with spaces goes through the batched read');
    assert.ok(answer.includes(`## M +1 -1 ${JSON.stringify('tab\there.txt')}\n@@ -1 +1 @@\n-a\n+b`), 'a quoted name is read on its own and still shown');
    assert.ok(answer.includes('## ? bin new/blob.bin'));
    assert.doesNotMatch(answer, /lockfileVersion/, 'the lock file’s content is not in the answer');

    // Against git: the same information as `git diff --numstat` + `git diff -U1` for these files, in no more room.
    const gitText = (await main.git('diff', '--numstat')) + (await main.git('diff', '--cached', '--numstat')) + (await main.git('diff', '-U1')) + (await main.git('diff', '--cached', '-U1'));
    assert.ok(answer.length <= gitText.length * 1.2, `list_changes with diffs is ${answer.length} chars, git ${gitText.length}`);
    await main.git('reset', '-q', '--hard');
    await main.git('clean', '-qfd');
  }

  // Budget: many small files fill one answer smallest first; the rest are listed with the reason.
  {
    for (let i = 0; i < 30; i++) await main.write(`bulk/f${String(i).padStart(2, '0')}.txt`, `${'y'.repeat(60)}\n`.repeat(30 + i));
    const answer = await call('list_changes', { repository: main.cwd, diffs: true });
    assert.ok(answer.length < DIFF_BUDGET + 4000, `${answer.length}`);
    const inlined = [...answer.matchAll(/^## \? \+(\d+) -0 bulk\/f\d\d\.txt\n@@/gm)].map(match => Number(match[1]));
    const left = [...answer.matchAll(/^## \? \+(\d+) -0 bulk\/f\d\d\.txt\n\(did not fit in this answer: read the file itself\)$/gm)].map(match => Number(match[1]));
    assert.equal(inlined.length + left.length, 30, answer.slice(0, 1500));
    assert.ok(left.length > 0 && inlined.length > 0);
    assert.ok(Math.max(...inlined) < Math.min(...left), 'the smaller files were the ones inlined');

    // maxBytes: the whole answer stays within it, every file is still listed, and the smallest are the ones shown.
    // (bulk/fNN grows with NN, so file numbers order them by size.)
    const numbers = (text, shownOnly) => [...text.matchAll(/^## \? (?:\+\d+ -0 )?bulk\/f(\d\d)\.txt\n(.)/gm)]
      .filter(match => (match[2] === '@') === shownOnly).map(match => Number(match[1]));
    for (const [maxBytes, limit] of [[4096, 6], [20000, 200]]) {
      const small = await call('list_changes', { repository: main.cwd, diffs: true, maxBytes, limit });
      assert.ok(Buffer.byteLength(small) <= maxBytes, `${Buffer.byteLength(small)} > ${maxBytes}`);
      const shown = numbers(small, true);
      const hidden = numbers(small, false);
      assert.equal(shown.length + hidden.length, Math.min(limit, 30), 'every file of the page keeps its line');
      assert.ok(shown.length > 0 && hidden.length > 0 && Math.max(...shown) < Math.min(...hidden), `${maxBytes}: smallest first — ${shown} / ${hidden}`);
    }
    // Tracked files that do not fit: one git diff per side reads all of them.
    await main.git('add', 'bulk');
    const staged = await call('list_changes', { repository: main.cwd, diffs: true, maxBytes: 8000 });
    const waiting = [...staged.matchAll(/^## A \+\d+ -0 (bulk\/f\d\d\.txt)\n\(did not fit in this answer\)$/gm)].map(match => match[1]);
    assert.ok(waiting.length > 0);
    assert.ok(staged.endsWith(`\nDid not fit, all in one call: git diff --cached -- ${waiting.join(' ')}\n`), staged.slice(-400));
    await main.git('reset', '-q');
    await expectError('INVALID_ARGUMENT', 'list_changes', { diffs: true, maxBytes: 1000 });
    await expectError('INVALID_ARGUMENT', 'list_changes', { diffs: true, maxBytes: 500000 });
    await main.git('clean', '-qfd');
  }

  // 5. Merge conflict.
  {
    const repo = await repository('conflicted');
    await repo.commit('Base', { 'shared.txt': 'base\n' });
    await repo.git('checkout', '-q', '-b', 'topic');
    await repo.commit('Topic change', { 'shared.txt': 'topic\n' });
    await repo.git('checkout', '-q', 'main');
    await repo.commit('Main change', { 'shared.txt': 'main\n' });
    const merge = await runGit({ cwd: repo.cwd, log, argv: ['merge', 'topic'] });
    assert.notEqual(merge.code, 0, 'the merge conflicts');
    const context = await call('get_workspace_context', { repository: repo.cwd });
    assert.deepEqual(context.operation, { kind: 'merge', step: null, total: null, conflicts: 1 });
    assert.equal(context.workingTree.conflicts, 1);
    assert.equal(context.repository.openInTwig, false);
    const changes = await call('list_changes', { repository: repo.cwd, diffs: true });
    assert.equal(changes, 'on main: 1 conflicted\nunstaged:\n## U shared.txt\n(conflicted: resolve it in 🌱 Twig, or read the file)\n');
    assert.deepEqual(context.repositories.map(item => [item.name, item.openInTwig ?? false]), [['alpha', true]], 'the other connected repositories, and which is open');

    // The agent's working directory picks the repository when a call names none.
    const inside = await sessionIn(path.join(repo.cwd, 'sub', 'dir'));
    assert.equal(await call('list_changes', {}, inside), changes.replace(/\n##.*\n\(.*\)\n$/, '\nU shared.txt\n'), 'the agent’s own repository, not the one open in 🌱 Twig, and not echoed back');
    assert.equal((await call('get_workspace_context', {}, inside)).repository.name, 'conflicted');
    assert.equal((await call('list_changes', { repository: main.cwd }, inside)).split('\n')[0], 'on main: no changes', 'a named repository still wins');
    const elsewhere = await sessionIn(os.tmpdir());
    const guessed = await call('list_changes', {}, elsewhere);
    assert.ok(guessed.startsWith(`repository: ${main.cwd}\nnote: Your working directory ${path.resolve(os.tmpdir())} is not a repository connected to 🌱 Twig`), guessed.slice(0, 200));
    assert.match((await call('get_workspace_context', {}, elsewhere)).repository.note, /not a repository connected/);
  }

  // An unborn branch has no history and says so.
  {
    const empty = await repository('empty');
    await expectError('COMMIT_NOT_FOUND', 'get_commit', { repository: empty.cwd, hash: 'HEAD' });
    assert.equal(await call('list_changes', { repository: empty.cwd }), 'on main (no commits yet): no changes\n');
    assert.equal((await call('get_workspace_context', { repository: empty.cwd })).branch.unborn, true);
  }

  // search_history and get_blame on a real repository; neither changes a byte.
  {
    const repo = await repository('search');
    const at = { repository: repo.cwd };
    const filler = Array.from({ length: 19 }, (_, i) => `// line ${i + 1}`).join('\n');
    const c1 = await repo.commit('Add math', { 'src/math.js': `${filler}\nexport function add(a, b) {\n  return a + b;\n}\n`, 'README.md': '# Search\n' });
    await repo.git('branch', 'old');
    const c2 = await repo.commit('Use add in app', { 'src/app.js': "import { add } from './math.js';\nconsole.log(add(1, 2));\n", 'other.txt': 'unrelated\n' });
    const c3 = await repo.commit('Rename add to sum', {
      'src/math.js': `${filler}\nexport function sum(a, b) {\n  return a + b;\n}\n`,
      'src/app.js': "import { sum } from './math.js';\nconsole.log(sum(1, 2));\n",
      'package-lock.json': '{"note": "add(1)"}\n', 'other.txt': 'still unrelated\n'
    });
    await repo.write('README.md', '# Search\n\nA typo fixed.\n');
    await repo.git('add', '-A');
    await repo.git('-c', 'user.name=Grace Hopper', '-c', 'user.email=grace@example.com', 'commit', '-q', '-m', 'Fix typo in README');
    const c4 = (await repo.git('rev-parse', 'HEAD')).trim();
    const commitsOf = text => text.split('\n').filter(line => /^[0-9a-f]{12} /.test(line)).map(line => line.slice(0, 12));
    const short = oid => oid.slice(0, 12);

    await repo.write('src/math.js', `${filler}\nexport function sum(a, b) {\n  // not committed\n  return a + b;\n}\n`);
    await repo.write('scratch.txt', 'new\n');
    const before = await fingerprint(repo.cwd);

    const code = await call('search_history', { ...at, query: 'add(' });
    assert.equal(code.split('\n')[0], 'HEAD: commits where "add(" was added or removed, newest first:');
    assert.deepEqual(commitsOf(code), [c3, c2, c1].map(short));
    assert.ok(!code.includes('other.txt') && !code.includes('README.md'), 'files without a match are left out');
    assert.ok(code.includes(`## A +1 -0 package-lock.json\n(lock or generated file: git show --format= ${short(c3)} -- package-lock.json)`), code);
    assert.ok(code.includes('## M +1 -1 src/math.js\n@@ -17,6 +17,6 @@\n // line 17\n // line 18\n // line 19\n-export function add(a, b) {\n+export function sum(a, b) {\n   return a + b;\n }\n'), code);
    assert.ok(!code.includes('// line 16'), 'only the lines around the match, not the whole hunk or file');
    assert.ok(code.includes('## A +2 -0 src/app.js\n@@ -0,0 +1,2 @@\n'));
    assert.ok(Buffer.byteLength(code) < 2000, `${Buffer.byteLength(code)}`);

    const tight = await call('search_history', { ...at, query: 'add(', contextLines: 0, path: 'src/math.js' });
    assert.deepEqual(commitsOf(tight), [c3, c1].map(short), 'path keeps the commits that changed it');
    assert.ok(tight.includes('@@ -20 +19,0 @@\n-export function add(a, b) {\n'), tight);
    assert.equal(tight.split('\n')[0], 'HEAD, in src/math.js: commits where "add(" was added or removed, newest first:');
    assert.deepEqual(commitsOf(await call('search_history', { ...at, query: 'add(', branch: 'old' })), [short(c1)]);
    assert.equal(commitsOf(await call('search_history', { ...at, query: 'add(', all: true })).length, 3);
    const regex = await call('search_history', { ...at, query: 'function [a-z]+\\(a, b\\)', mode: 'regex' });
    assert.deepEqual(commitsOf(regex), [c3, c1].map(short));
    assert.ok(regex.includes('-export function add(a, b) {\n+export function sum(a, b) {'));
    const messages = await call('search_history', { ...at, query: 'TYPO', mode: 'message' });
    assert.deepEqual(commitsOf(messages), [short(c4)]);
    assert.ok(!messages.includes('##') && !messages.includes('@@'), 'message search lists commits only');
    assert.match(await call('search_history', { ...at, query: 'grace', mode: 'author' }), /^HEAD: commits by an author matching "grace", newest first:\n[0-9a-f]{12} \d{4}-\d\d-\d\d Grace Hopper: Fix typo in README\n$/);
    const first = await call('search_history', { ...at, query: 'add(', limit: 1 });
    assert.deepEqual(commitsOf(first), [short(c3)]);
    assert.match(first, /… more: search_history with cursor "1"\n$/);
    assert.deepEqual(commitsOf(await call('search_history', { ...at, query: 'add(', limit: 1, cursor: '2' })), [short(c1)]);
    assert.equal(await call('search_history', { ...at, query: 'multiply(' }), 'HEAD: no commits where "multiply(" was added or removed\n');
    assert.match((await expectError('INVALID_ARGUMENT', 'search_history', { ...at, query: 'add(', mode: 'regex' })).message, /Git cannot use that pattern/);
    await expectError('INVALID_ARGUMENT', 'search_history', { ...at, query: 'x', mode: 'shell' });
    await expectError('INVALID_ARGUMENT', 'search_history', { ...at, query: 'x', path: '../outside' });
    await expectError('INVALID_ARGUMENT', 'search_history', { ...at, query: 'x', branch: '--all' });
    await expectError('INVALID_ARGUMENT', 'search_history', { ...at, query: 'x', branch: 'old', all: true });
    await expectError('REF_NOT_FOUND', 'search_history', { ...at, query: 'x', branch: 'nope' });
    await expectError('INVALID_ARGUMENT', 'search_history', { ...at });

    // Blame: runs and a commit table, the file on disk by default.
    const blame = await call('get_blame', { ...at, path: 'src/math.js' });
    const [runsPart, tablePart] = blame.split('commits:\n');
    assert.equal(runsPart, [
      'src/math.js on disk, lines 1-23: 4 runs from 2 commits, some not committed yet',
      `1-19 ${short(c1)}`, `20 ${short(c3)}`, '21 uncommitted', `22-23 ${short(c1)}`, ''
    ].join('\n'));
    // Newest first; these two were made in the same second, so only the set is certain.
    assert.deepEqual(tablePart.trim().split('\n').map(line => line.replace(/ \d{4}-\d\d-\d\d /, ' DATE ')).sort(),
      [`${short(c1)} DATE Ada Lovelace: Add math`, `${short(c3)} DATE Ada Lovelace: Rename add to sum`].sort());
    const withCode = await call('get_blame', { ...at, path: 'src/math.js', startLine: 20, endLine: 21, code: true });
    assert.ok(withCode.startsWith(`src/math.js on disk, lines 20-21: 2 runs from 1 commit, some not committed yet\n20 ${short(c3)}\n\texport function sum(a, b) {\n21 uncommitted\n\t  // not committed\ncommits:\n`), withCode);
    const old = await call('get_blame', { ...at, path: 'src/math.js', revision: 'old', startLine: 20 });
    assert.ok(old.startsWith(`src/math.js at ${short(c1)}, lines 20-22: 1 run from 1 commit\n20-22 ${short(c1)}\ncommits:\n`), old);
    await expectError('INVALID_ARGUMENT', 'get_blame', { ...at, path: 'src/math.js', startLine: 99 });
    await expectError('INVALID_ARGUMENT', 'get_blame', { ...at, path: 'src/math.js', startLine: 5, endLine: 2 });
    await expectError('FILE_NOT_FOUND', 'get_blame', { ...at, path: 'scratch.txt' });
    await expectError('FILE_NOT_FOUND', 'get_blame', { ...at, path: 'src/app.js', revision: 'old' });
    await expectError('COMMIT_NOT_FOUND', 'get_blame', { ...at, path: 'src/math.js', revision: 'v9' });
    await expectError('INVALID_ARGUMENT', 'get_blame', { ...at, path: '../outside.js' });
    await expectError('INVALID_ARGUMENT', 'get_blame', { ...at, path: 'src/math.js', revision: '--all' });
    assert.equal(await fingerprint(repo.cwd), before, 'search and blame changed nothing in .git or the working tree');
    await repo.git('checkout', '--', 'src/math.js');

    // A search that matches a lot fills one answer by whole commits and pages on; a file with many matches says how many more.
    const long = 'x'.repeat(180);
    for (let i = 0; i < 12; i++) {
      await repo.commit(`Spread needle ${i}`, { [`spread/${i}.txt`]: Array.from({ length: 80 }, (_, line) => (line % 10 === 0 ? `needle ${line} ${long}` : `hay ${line} ${long}`)).join('\n') + '\n' });
    }
    const full = await call('search_history', { ...at, query: 'needle', limit: 12 });
    assert.ok(Buffer.byteLength(full) <= DIFF_BUDGET + 4096, `${Buffer.byteLength(full)}`);
    const shown = commitsOf(full).length;
    assert.ok(shown > 1 && shown < 12, `${shown}`);
    assert.match(full, new RegExp(`… more: search_history with cursor "${shown}"\\n$`));
    assert.ok(full.includes(`… ${8 - WINDOWS_PER_FILE} more matches in this file: git show --format= `));
    assert.equal(commitsOf(await call('search_history', { ...at, query: 'needle', limit: 12, cursor: String(shown) })).length, Math.min(12, 12 - shown));
    assert.ok(log.list().some(entry => entry.operation === 'MCP: Search history') && log.list().some(entry => entry.operation === 'MCP: Blame lines'));
  }

  // UI context: what the window reported, only for the repository it reported about.
  {
    const head = (await main.git('rev-parse', 'HEAD')).trim();
    ui = normalizeUiContext({ repositoryId: main.cwd, view: 'history', selectedCommit: head, selectedCommits: [], compare: null, selectedFile: { path: 'big.txt', commit: head, side: null } });
    const context = await call('get_ui_context');
    assert.equal(context.repository.path, main.cwd);
    assert.equal(context.view, 'history');
    assert.equal(context.selectedCommit, head);
    assert.deepEqual(context.selectedFile, { path: 'big.txt', commit: head, side: null });
    assert.equal(context.selectedBranch, null);
    assert.equal(context.selectedHunk, null);
    assert.deepEqual((await call('get_workspace_context')).selection, { view: 'history', commit: head, file: 'big.txt' });
    assert.equal((await call('get_workspace_context', { repository: 'conflicted' })).selection, null, 'the selection belongs to another repository');
    activeId = path.join(root, 'conflicted');
    assert.equal((await call('get_ui_context')).selectedCommit, null, 'a new active repository has no reported selection yet');
    activeId = main.cwd;
    assert.deepEqual((await call('get_workspace_context', { repository: 'search' })).repositories.filter(repo => repo.openInTwig).map(repo => repo.name), ['alpha']);
  }

  // --- the socket transport and the stdio bridge, end to end ---------------------------------
  {
    const userData = path.join(root, 'user data');
    const service = createMcpService({ userData, execPath: process.execPath, version: '9.9.9', repositories, journal: log });
    service.follow(main.cwd);
    await service.configure(true);
    assert.equal(service.status().listening, true, service.status().error);
    const dir = service.endpoint.dir;
    assert.equal((await stat(dir)).mode & 0o777, 0o700, 'the bridge folder is private');
    if (service.endpoint.socketDir !== dir) assert.equal((await stat(service.endpoint.socketDir)).mode & 0o777, 0o700);
    assert.equal((await stat(service.endpoint.socket)).mode & 0o777, 0o600, 'the socket is private');
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'endpoint.json'), 'utf8')), { socket: service.endpoint.socket, version: '9.9.9' });
    assert.equal(service.config().launch.args[0], path.join(dir, 'twig-mcp.mjs'));

    // The bridge runs as a client would start it, from the copied folder.
    function startBridge(cwd = process.cwd()) {
      const child = spawn(process.execPath, [path.join(dir, 'twig-mcp.mjs')], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      const waiting = new Map();
      let buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          waiting.get(message.id)?.(message);
          waiting.delete(message.id);
        }
      });
      let id = 100;
      return {
        child,
        request(method, params) {
          const current = id++;
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`bridge did not answer ${method}`)), 10_000);
            waiting.set(current, message => { clearTimeout(timer); resolve(message); });
            child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, ...(params ? { params } : {}) })}\n`);
          });
        },
        notify(method) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); },
        async close() { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); }
      };
    }
    const text = message => JSON.parse(message.result.content[0].text);

    const bridge = startBridge();
    const init = await bridge.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'twig');
    bridge.notify('notifications/initialized');
    assert.equal((await bridge.request('tools/list')).result.tools.length, TOOLS.length);
    assert.equal(text(await bridge.request('tools/call', { name: 'get_workspace_context', arguments: {} })).repository.path, main.cwd);
    assert.equal(service.status().connections, 1);
    assert.ok(service.status().calls >= 1);

    // 🌱 Twig stops listening: the bridge answers by itself, and the client keeps its tools.
    await service.configure(false);
    assert.equal(service.status().listening, false);
    await assert.rejects(stat(service.endpoint.socket), 'no socket while Off');
    const off = await bridge.request('tools/call', { name: 'get_workspace_context', arguments: {} });
    assert.equal(off.result.isError, true);
    assert.equal(text(off).error.code, 'TWIG_UNAVAILABLE');
    assert.equal((await bridge.request('tools/list')).result.tools.length, TOOLS.length);

    // And on again: the same bridge reattaches without the client doing anything.
    await service.configure(true);
    assert.match((await bridge.request('tools/call', { name: 'list_changes', arguments: {} })).result.content[0].text, new RegExp(`^repository: ${main.cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`),
      'the bridge runs outside any connected repository here, so the open one is read and named');
    await bridge.close();

    // A client started in a connected repository gets that one without naming it: the bridge reports its folder.
    const local = startBridge(path.join(root, 'conflicted'));
    await local.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
    assert.equal((await local.request('tools/call', { name: 'list_changes', arguments: {} })).result.content[0].text, 'on main: 1 conflicted\nunstaged:\nU shared.txt\n');
    await local.close();

    // A bridge started while 🌱 Twig is off still initializes and lists its tools.
    await service.configure(false);
    const cold = startBridge();
    const coldInit = await cold.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'check', version: '1' } });
    assert.equal(coldInit.result.protocolVersion, '2024-11-05');
    assert.equal(coldInit.result.serverInfo.version, '0.0.0', 'without an endpoint file the bridge cannot know the version');
    assert.equal((await cold.request('tools/list')).result.tools.length, TOOLS.length);
    await service.configure(true);
    assert.equal(text(await cold.request('tools/call', { name: 'get_ui_context', arguments: {} })).repository.path, main.cwd, 'replayed initialize, then the call');
    await cold.close();
    await service.configure(false);

    // The UI-context report is validated before it is kept.
    assert.equal(service.setUiContext({ repositoryId: main.cwd, view: 'nope' }), false);
    assert.equal(service.setUiContext({ repositoryId: main.cwd, view: 'staging', selectedCommits: [] }), true);
    assert.equal(service.context.ui().view, 'staging');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('mcp: catalog, readers, tools on real repositories, read-only, transport and bridge');
