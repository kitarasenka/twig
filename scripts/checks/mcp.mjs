import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { parseNumstat, buildWorktreeNumstatArgv, buildCommitNumstatArgv } from '../../main/git/numstat.js';
import { validateRevision } from '../../main/git/commit.js';
import { buildRefHistoryArgv } from '../../main/git/history.js';
import { buildDiffArgv, buildDiffsArgv, buildUntrackedDiffArgv, chunkPath } from '../../main/git/worktree.js';
import { splitPatchFiles, parseFilePatchV1 } from '../../main/git/diff-parser.js';
import { TOOLS, PROTOCOL_VERSIONS, CWD_META, negotiateVersion, toolResult } from '../../main/mcp/protocol.mjs';
import { TOOL_NAMES, bindTools } from '../../main/mcp/tools/index.js';
import { validateArguments, readCursor } from '../../main/mcp/arguments.js';
import { McpError, ERROR_CODES } from '../../main/mcp/errors.js';
import { normalizeUiContext, uiContextFor } from '../../main/mcp/ui-context.js';
import { resolveEndpoint, launchCommand, clientConfigs } from '../../main/mcp/endpoint.js';
import { hunkId, parseHunkId, fitHunks, capHunk, HUNK_BUDGET, DIFF_BUDGET, fileLine, quotePath, hunkHeader, commitLine } from '../../main/mcp/serialize.js';
import { isGeneratedPath, FILE_LINE_LIMIT } from '../../main/mcp/tools/changes.js';
import { summarizeWorktree } from '../../main/mcp/tools/workspace.js';
import { createMcpSession, clientCwd, MAX_RESULT_CHARS } from '../../main/mcp/session.js';
import { createToolContext } from '../../main/mcp/context.js';
import { createMcpService } from '../../main/mcp/service.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';
import { buildUiContext } from '../../renderer/src/features/graph/ui-context-report.js';
import { mcpStatusLine, mcpSummary, mcpToolTitle } from '../../renderer/src/features/settings/mcp-view.js';

// --- the catalog: read-only, and nothing that runs commands ----------------------------
assert.deepEqual(TOOLS.map(tool => tool.name), TOOL_NAMES, 'every catalog entry has an implementation, in the same order');
for (const tool of TOOLS) {
  assert.equal(tool.annotations.readOnlyHint, true, tool.name);
  assert.equal(tool.annotations.destructiveHint, false, tool.name);
  assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  assert.match(tool.name, /^(?:get|list)_/, `${tool.name}: every tool only reads`);
  assert.doesNotMatch(tool.name, /run|exec|shell|command|stage|checkout|reset|merge|rebase|push|delete|create/, tool.name);
}
assert.equal(negotiateVersion('2025-03-26'), '2025-03-26');
assert.equal(negotiateVersion('1999-01-01'), PROTOCOL_VERSIONS[0]);
assert.ok(ERROR_CODES.includes('NO_REPOSITORY_OPEN') && ERROR_CODES.includes('OUTPUT_TOO_LARGE'));
assert.throws(() => new McpError('SOMETHING_ELSE', 'x'), TypeError);

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
assert.deepEqual(buildRefHistoryArgv({ revision: 'main', limit: 5 }).slice(-3), ['--end-of-options', 'main', '--']);
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

// --- arguments, cursors, hunk ids and budgets ---------------------------------------------
{
  const schema = TOOLS.find(tool => tool.name === 'get_diff').inputSchema;
  assert.deepEqual(validateArguments(schema, { path: 'a' }), { path: 'a', staged: false, contextLines: 3 });
  assert.deepEqual(validateArguments(TOOLS.find(tool => tool.name === 'list_changes').inputSchema, {}), { diffs: false, contextLines: 3, maxBytes: 60000, limit: 200 });
  for (const bad of [{}, { path: 1 }, { path: 'a', extra: 1 }, { path: 'a', contextLines: 99 }, { path: 'a', contextLines: 1.5 }, { path: 'a\0' }, []]) {
    assert.throws(() => validateArguments(schema, bad), error => error.code === 'INVALID_ARGUMENT', JSON.stringify(bad));
  }
  const history = TOOLS.find(tool => tool.name === 'get_history').inputSchema;
  assert.equal(validateArguments(history, { branch: null }).branch, null, 'a nullable argument accepts null');
  assert.equal(readCursor(undefined), 0);
  assert.equal(readCursor('40'), 40);
  assert.throws(() => readCursor('-1'), error => error.code === 'INVALID_ARGUMENT');
}
{
  const id = hunkId('w', 3, 'a.txt', '@@ -1 +1 @@\n-a\n+b\n');
  assert.match(id, /^w3-[0-9a-f]{8}$/);
  assert.notEqual(id, hunkId('w', 3, 'b.txt', '@@ -1 +1 @@\n-a\n+b\n'), 'the path is part of the id');
  assert.deepEqual(parseHunkId(id), { side: 'w', context: 3 });
  assert.throws(() => parseHunkId('w3-xyz'), error => error.code === 'INVALID_HUNK');
  const hunks = [{ id: 'a', patch: 'x'.repeat(40) }, { id: 'b', patch: 'y'.repeat(40) }, { id: 'c', patch: 'z'.repeat(5) }];
  const fitted = fitHunks(hunks, 60);
  assert.deepEqual(fitted.hunks.map(hunk => hunk.patch === null), [false, true, true], 'order is kept: nothing after the first left-out hunk');
  assert.equal(fitted.truncated, true);
  const big = capHunk({ id: 'x', patch: '@@ -1 +1 @@\n' + '+line\n'.repeat(30_000) });
  assert.ok(big.truncated && big.patch.length <= HUNK_BUDGET && big.omittedLines > 0);
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
  await expectError('NO_REPOSITORY_OPEN', 'get_workspace_context');
  await expectError('NO_REPOSITORY_OPEN', 'list_changes');
  await expectError('NO_REPOSITORY_OPEN', 'get_history');
  assert.deepEqual(await call('get_ui_context'), { repository: null, view: null, selectedBranch: null, selectedCommit: null, selectedCommits: [], compare: null, selectedFile: null, selectedHunk: null });
  assert.deepEqual(await call('list_repositories'), { repositories: [] });

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

    // 10. get_diff of one file — only that file, as text.
    const diff = await call('get_diff', { repository: main.cwd, path: 'src/app.js' });
    assert.equal(diff, 'M +2 -0 src/app.js (unstaged)\n@@ -1 +1,3 @@\n export const one = 1;\n+export const two = 2;\n+export const three = 3;\n');
    const tight = await call('get_diff', { repository: main.cwd, path: 'src/app.js', contextLines: 0 });
    assert.ok(!tight.split('\n').slice(2).some(line => line.startsWith(' ')), 'no context lines asked for, none given');

    const staged = await call('get_diff', { repository: main.cwd, path: 'README.md', staged: true });
    const unstaged = await call('get_diff', { repository: main.cwd, path: 'README.md' });
    assert.ok(staged.startsWith('M +2 -0 README.md (staged)\n') && staged.includes('+Staged line.') && !staged.includes('+Unstaged line.'));
    assert.ok(unstaged.includes('+Unstaged line.') && !unstaged.includes('+Staged line.'));
    const notStaged = await expectError('FILE_NOT_FOUND', 'get_diff', { path: 'src/app.js', staged: true });
    assert.match(notStaged.hint, /staged: false/);
    assert.match((await expectError('FILE_NOT_FOUND', 'get_diff', { path: 'docs/guide.md' })).hint, /staged: true/);

    const untracked = await call('get_diff', { repository: main.cwd, path: 'notes/todo.txt' });
    assert.equal(untracked, '? +2 -0 notes/todo.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n');

    // One call for everything: list_changes with diffs is the same list with each patch under its line.
    const all = await call('list_changes', { repository: main.cwd, diffs: true });
    assert.deepEqual(sections(all), { ...sections(changes), untracked: ['? +2 -0 notes/todo.txt'] }, 'the same file lines, and an untracked file gets its count once read');
    assert.ok(all.includes(diff.split('\n').slice(1).join('\n')), 'src/app.js is printed exactly as get_diff prints it');
    assert.ok(all.includes('## M +2 -0 README.md\n@@') && all.includes('+Staged line.') && all.includes('+Unstaged line.'));
    assert.ok(all.includes('## ? +2 -0 notes/todo.txt\n@@ -0,0 +1,2 @@\n+one\n+two'));
    assert.ok(all.includes('## D +0 -1 docs/guide.md\n@@ -1 +0,0 @@\n-Read me.'));
    const reads = log.list().filter(entry => entry.operation === 'MCP: Read working tree diffs' || entry.operation === 'MCP: Read staged diffs').length;
    await call('list_changes', { repository: main.cwd, diffs: true });
    assert.equal(log.list().filter(entry => entry.operation === 'MCP: Read working tree diffs' || entry.operation === 'MCP: Read staged diffs').length - reads, 2,
      'tracked files are read with one git diff per side, not one per file');

    // Hunk ids appear only on hunks that were not shown (below, with the large file); they are checked, not trusted.
    const stagedId = hunkId('s', 3, 'README.md', staged.slice(staged.indexOf('\n') + 1));
    const one = await call('get_diff_hunk', { repository: main.cwd, path: 'README.md', hunkId: stagedId });
    assert.equal(one, `README.md (staged) [${stagedId}: +2 -0]\n${staged.slice(staged.indexOf('\n') + 1)}`);
    const untrackedId = hunkId('u', 3, 'notes/todo.txt', '@@ -0,0 +1,2 @@\n+one\n+two\n');
    assert.ok((await call('get_diff_hunk', { repository: main.cwd, path: 'notes/todo.txt', hunkId: untrackedId })).endsWith('@@ -0,0 +1,2 @@\n+one\n+two\n'));
    await expectError('INVALID_HUNK', 'get_diff_hunk', { path: 'README.md', hunkId: stagedId.replace(/^s/, 'w') });
    await expectError('INVALID_HUNK', 'get_diff_hunk', { path: 'README.md', hunkId: 'not-an-id' });

    // 7. nonexistent file, and paths that are not repository paths at all.
    assert.match((await expectError('FILE_NOT_FOUND', 'get_diff', { path: 'nope.txt' })).hint, /list_changes/);
    await expectError('INVALID_ARGUMENT', 'get_diff', { path: '../outside.txt' });
    await expectError('INVALID_ARGUMENT', 'get_diff', { path: '/etc/passwd' });
    await expectError('INVALID_ARGUMENT', 'get_diff', {});

    // Repository selection by path inside it, and refusal of anything not connected.
    assert.equal((await call('get_workspace_context', { repository: path.join(main.cwd, 'src') })).repository.name, 'alpha');
    assert.match(await call('list_changes', { repository: 'alpha' }), /^on main: 2 staged/);
    await expectError('REPOSITORY_NOT_FOUND', 'list_changes', { repository: os.tmpdir() });
    await expectError('REPOSITORY_NOT_FOUND', 'list_changes', { repository: 'beta' });

    // History and commits read nothing from the working tree.
    await call('get_history');
    await call('get_commit', { hash: 'HEAD' });
    await call('get_commit_diff', { hash: 'HEAD' });
    assert.equal(await fingerprint(main.cwd), before, 'no tool changed a byte in .git or the working tree');
    assert.ok(log.list().filter(entry => entry.operation.startsWith('MCP: ')).length > 20, 'agent reads are in the journal, marked MCP');

    // A hunk id goes stale when its file changes.
    const appId = hunkId('w', 3, 'src/app.js', diff.slice(diff.indexOf('\n') + 1));
    assert.ok(await call('get_diff_hunk', { repository: main.cwd, path: 'src/app.js', hunkId: appId }));
    await main.write('src/app.js', 'export const one = 1;\nexport const two = 22;\n');
    assert.match((await expectError('INVALID_HUNK', 'get_diff_hunk', { path: 'src/app.js', hunkId: appId })).hint, /get_diff again/);
  }
  await main.git('add', '-A');
  await main.git('commit', '-q', '-m', 'Second commit\n\nWith a body that explains it.');

  // 9. get_history and its limit; get_commit; get_commit_diff.
  {
    for (let i = 0; i < 24; i++) await main.commit(`Step ${i}`, { 'counter.txt': `${i}\n` });
    const at = { repository: main.cwd };
    const history = text => text.split('\n').filter(line => /^[0-9a-f]{12} /.test(line));
    const page = await call('get_history', { ...at, limit: 10 });
    assert.equal(history(page).length, 10);
    assert.match(page, /^HEAD, newest first:\n/);
    assert.match(history(page)[0], /^[0-9a-f]{12} \d{4}-\d\d-\d\d Ada Lovelace: Step 23$/);
    assert.match(page, /… more: get_history with cursor "10"\n$/);
    const next = await call('get_history', { ...at, limit: 10, cursor: '10' });
    assert.match(history(next)[0], /: Step 13$/);
    const last = await call('get_history', { ...at, limit: 100 });
    assert.equal(history(last).length, 26);
    assert.doesNotMatch(last, /more:/);
    await expectError('INVALID_ARGUMENT', 'get_history', { limit: 101 });
    await main.git('branch', 'side', first);
    assert.deepEqual(history(await call('get_history', { ...at, branch: 'side' })).map(line => line.slice(0, 12)), [first.slice(0, 12)]);
    assert.equal(history(await call('get_history', { ...at, all: true, limit: 100 })).length, 26);
    await expectError('REF_NOT_FOUND', 'get_history', { branch: 'no-such-branch' });
    await expectError('INVALID_ARGUMENT', 'get_history', { branch: '--all' });

    const second = history(last).find(line => line.endsWith(': Second commit')).slice(0, 12);
    const commit = await call('get_commit', { ...at, hash: second.slice(0, 9) });
    const [title, authorLine, parentsLine] = commit.split('\n');
    assert.match(title, new RegExp(`^${second}[0-9a-f]{28} Second commit$`));
    const secondOid = title.slice(0, 40);
    assert.match(authorLine, /^author: Ada Lovelace <ada@example\.com> \d{4}-/);
    assert.equal(parentsLine, `parents: ${first.slice(0, 12)}`);
    assert.ok(commit.includes('\n\nWith a body that explains it.\n\n'));
    assert.ok(commit.includes('4 files, +6 -1:\n') && commit.includes('\nD +0 -1 docs/guide.md\n'));
    assert.ok(!commit.includes('@@'), 'get_commit carries no patch');
    assert.match(await call('get_commit', { ...at, hash: first }), /\nparents: none \(root commit\)\n/);

    // 8. nonexistent commit.
    await expectError('COMMIT_NOT_FOUND', 'get_commit', { hash: 'deadbeefdeadbeef' });
    await expectError('COMMIT_NOT_FOUND', 'get_commit_diff', { hash: 'v9.9.9' });
    await expectError('INVALID_ARGUMENT', 'get_commit', { hash: '--output=/tmp/x' });

    const whole = await call('get_commit_diff', { ...at, hash: secondOid });
    assert.equal(whole.split('\n')[0], `${second} Second commit (4 files, +6 -1)`);
    assert.deepEqual(whole.split('\n').filter(line => line.startsWith('## ')).map(line => line.split(' ').at(-1)), ['README.md', 'docs/guide.md', 'notes/todo.txt', 'src/app.js']);
    assert.ok(whole.includes('## A +2 -0 notes/todo.txt\n@@ -0,0 +1,2 @@'));
    assert.doesNotMatch(whole, /not shown/);
    const single = await call('get_commit_diff', { ...at, hash: secondOid, path: 'src/app.js' });
    assert.equal(single.split('\n')[0], `M +1 -0 src/app.js (${second})`, 'the file as committed, after the stale-hunk edit');
    const singleId = hunkId('c', 3, 'src/app.js', single.slice(single.indexOf('\n') + 1));
    assert.ok((await call('get_commit_diff', { ...at, hash: secondOid, path: 'src/app.js', hunkId: singleId })).endsWith(single.slice(single.indexOf('\n') + 1)));
    await expectError('FILE_NOT_FOUND', 'get_commit_diff', { hash: secondOid, path: 'counter.txt' });
    await expectError('INVALID_ARGUMENT', 'get_commit_diff', { hash: secondOid, hunkId: singleId });
    await expectError('INVALID_HUNK', 'get_diff_hunk', { path: 'src/app.js', hunkId: singleId });

    // A commit too large to read whole answers with its file list.
    const many = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`gen/file-${i}.txt`, `${i}\n`]));
    const big = await main.commit('Generate files', many);
    const list = await call('get_commit_diff', { ...at, hash: big });
    assert.equal(list.split('\n').filter(line => line.startsWith('A +1 -0 gen/')).length, 61);
    assert.ok(!list.includes('@@'));
    assert.match(list, /get_commit_diff with a path/);
  }

  // 6. A large diff comes back with the hunks past the budget as headers and ids, and any hunk can then be fetched.
  {
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    await main.commit('Large file', { 'big.txt': lines.join('\n') + '\n' });
    await main.write('big.txt', lines.map((line, i) => (i % 20 === 0 ? `${line} changed` : line)).join('\n') + '\n');
    const diff = await call('get_diff', { repository: main.cwd, path: 'big.txt' });
    assert.match(diff, /get_diff_hunk reads one by its id\.\n$/);
    const skipped = [...diff.matchAll(/^@@ .* \[(w3-[0-9a-f]{8}): \+1 -1, not shown\]$/gm)].map(match => match[1]);
    const shown = diff.split('\n').filter(line => line.startsWith('@@') && !line.includes('not shown')).length;
    assert.equal(skipped.length + shown, 300);
    assert.ok(skipped.length > 0 && shown > 0);
    assert.ok(diff.length < MAX_RESULT_CHARS);
    const fetched = await call('get_diff_hunk', { repository: main.cwd, path: 'big.txt', hunkId: skipped.at(-1) });
    assert.ok(fetched.includes('changed') && !fetched.includes('more lines not shown'));

    // list_changes with diffs lists a file over the line limit instead of inlining it.
    const listed = await call('list_changes', { repository: main.cwd, diffs: true });
    assert.ok(listed.includes(`## M +300 -300 big.txt\n(over ${FILE_LINE_LIMIT} changed lines: get_diff reads it)`));

    // A single hunk larger than one answer is cut at a line, with the count of what was left out.
    await main.write('big.txt', lines.map(line => `${line}!`).join('\n') + '\n');
    const huge = await call('get_diff', { repository: main.cwd, path: 'big.txt' });
    const hugeId = /\[(w3-[0-9a-f]{8}): \+6000 -6000, not shown\]/.exec(huge)?.[1];
    assert.ok(hugeId, huge.slice(0, 200));
    const cut = await call('get_diff_hunk', { repository: main.cwd, path: 'big.txt', hunkId: hugeId });
    assert.match(cut, /\(… \d+ more lines not shown: the hunk is larger than one answer\)\n$/);
    assert.ok(cut.length < MAX_RESULT_CHARS);
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
    assert.ok(answer.includes('## M +1 -1 package-lock.json\n(lock or generated file: get_diff reads it)'));
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
    const left = [...answer.matchAll(/^## \? \+(\d+) -0 bulk\/f\d\d\.txt\n\(did not fit in this answer: get_diff reads it\)$/gm)].map(match => Number(match[1]));
    assert.equal(inlined.length + left.length, 30);
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
    const diff = await call('get_diff', { repository: repo.cwd, path: 'shared.txt' });
    assert.match(diff, /^U shared\.txt \(unstaged\)\n\(conflicted: /);

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
    assert.equal(await call('get_history', { repository: empty.cwd }), 'HEAD: no commits yet\n');
    assert.equal(await call('list_changes', { repository: empty.cwd }), 'on main (no commits yet): no changes\n');
    assert.equal((await call('get_workspace_context', { repository: empty.cwd })).branch.unborn, true);
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
    assert.equal((await call('list_repositories')).repositories.filter(repo => repo.openInTwig).length, 1);
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
