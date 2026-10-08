// How many tokens an agent spends on the same question, asked through git in
// a shell and through 🌱 Twig's MCP tools. Not a check: it measures, prints a
// table and writes artifacts/mcp-tokens/ (every answer, as the agent got it,
// plus results.json), so a number on the site can be traced to its text.
//
//   node scripts/mcp-tokens.mjs            bytes only, no network
//   node scripts/mcp-tokens.mjs --count    + exact tokens: each text is sent to
//                                          Claude through `claude -p` and the
//                                          difference in input tokens against
//                                          an empty prompt is its size
//   --only=changes | --only=search         one of the two sets below
//
// Scenarios are real changes from this repository's own history: the parent
// commit is checked out in a throwaway clone and the change is put back as
// uncommitted work (modified files unstaged, new files untracked) — the state
// an agent finds when it is asked to commit it.
//
// The search set asks about history instead, on a clean checkout of a pinned
// commit: when was some code added or removed (git log -S … -p — and, to be
// fair, the same piped through grep, which only a careful agent writes) and
// who last changed some lines and why (git blame, then git log -1 per commit).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandLog } from '../main/command-log.js';
import { CWD_META, TOOLS } from '../main/mcp/protocol.mjs';
import { createToolContext } from '../main/mcp/context.js';
import { createMcpSession } from '../main/mcp/session.js';
import { bindTools } from '../main/mcp/tools/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts/mcp-tokens');
const COUNT = process.argv.includes('--count');
const MODEL = 'claude-opus-5-5';
const ONLY = process.argv.find(arg => arg.startsWith('--only='))?.slice(7) ?? null;
const GARDEN = path.join(os.homedir(), 'projects/garden');

const SCENARIOS = [
  { id: 'small', commit: 'fdfdeb6', label: 'Bug fix: 4 files, +80 −2' },
  { id: 'medium', commit: '5bb7b12', label: 'Feature: 7 files, +154 −7' },
  { id: 'large', commit: '672a8b8', label: 'Large feature: 28 files, +1048 −44' },
  // A new dependency: the same kind of change, with package-lock.json in it.
  // From another project of ours (a TypeScript game); skipped where it is absent.
  { id: 'dependency', repo: GARDEN, commit: 'dde8126', label: 'Feature + dependency: 14 files, +726 −41, 131 of them in package-lock.json' }
];

const SEARCHES = [
  {
    id: 'twig', commit: 'c61ac19', label: '🌱 Twig, 74 commits',
    queries: ['plainFs', 'readPreviousTag', 'validateRevision', 'undo.perform'],
    blames: [['main/mcp/tools/history.js', 90, 144], ['renderer/src/features/graph/HistoryWorkspace.jsx', 400, 460], ['main/git/history.js', null, null]]
  },
  { id: 'garden', repo: GARDEN, commit: '1e5b2ff', label: 'Ghost Garden, 107 commits', queries: ['requestAnimationFrame'], blames: [] }
];

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C' } });

/** One shell call as the agent sees it: the command it wrote and what came back. */
const shell = (cwd, command, args) => ({ call: `Bash: ${command}`, text: git(cwd, args) });

const tmp = await mkdtemp(path.join(os.tmpdir(), 'twig-tokens-'));
const log = new CommandLog(tmp);
await log.load();
const repos = [];
const ctx = createToolContext({ repositories: { snapshot: () => ({ repositories: repos }) }, journal: log, getActiveId: () => repos[0]?.id ?? null, getUiContext: () => null });
let session = null;
let rpc = 1;
/** A session whose agent was started in `cwd`, as the stdio bridge reports it — so answers carry no `repository:` note. */
async function openSession(cwd) {
  session = createMcpSession({ version: 'measure', tools: bindTools(ctx) });
  await session.handle({ jsonrpc: '2.0', id: rpc++, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, _meta: { [CWD_META]: cwd } } });
}
async function mcp(name, args = {}) {
  const response = await session.handle({ jsonrpc: '2.0', id: rpc++, method: 'tools/call', params: { name, arguments: args } });
  if (!response.result || response.result.isError) throw new Error(`${name}: ${JSON.stringify(response)}`);
  return { call: `mcp__twig__${name} ${JSON.stringify(args)}`, text: response.result.content[0].text };
}

/** What `grep -E -C<context> <pattern>` prints: matching lines with context, groups split by `--`. */
function grepContext(text, pattern, context = 3) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const keep = new Set();
  lines.forEach((line, index) => { if (pattern.test(line)) for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) keep.add(i); });
  const out = [];
  let last = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (out.length && index !== last + 1) out.push('--');
    out.push(lines[index]);
    last = index;
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/** A clone of `source` checked out at `commit`, connected as the only repository, with a session started in it. */
async function checkout(id, source, commit) {
  const cwd = path.join(tmp, id);
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', source, cwd]);
  git(cwd, ['checkout', '--quiet', '--detach', commit]);
  repos.splice(0, repos.length, { id: cwd, name: id, path: cwd, available: true });
  await openSession(cwd);
  return cwd;
}

/** The path of a `## M +2 -1 path` file line (the new name of a rename), or null. */
function filePath(line) {
  const match = line.match(/^## \S (?:bin|\+\d+ -\d+) (.+)$/);
  if (!match) return null;
  const name = match[1].includes(' -> ') ? match[1].split(' -> ').pop() : match[1];
  return name.startsWith('"') ? JSON.parse(name) : name;
}

/** A command as a POSIX shell splits it — enough for the ones 🌱 Twig prints: bare words and single quotes. */
function shellWords(command) {
  const words = [];
  let word = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === ' ') { if (word !== null) words.push(word); word = null; continue; }
    word ??= '';
    if (char === "'") { const end = command.indexOf("'", i + 1); word += command.slice(i + 1, end); i = end; }
    else if (char === '\\') word += command[++i];
    else word += char;
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * What an answer left out — a file that "did not fit", is too long, renamed
 * with edits or changed type — read the way the answer says: the git command
 * it prints, or the file itself when it is new. So the agent ends up knowing
 * as much as from the git output it is compared with.
 */
function readRest(cwd, text) {
  const calls = [];
  let file = null;
  for (const line of text.split('\n')) {
    file = filePath(line) ?? file;
    // Lock and generated files stay unread: the reason they are left out is
    // that nobody reads them — but `git diff` hands them over all the same.
    const note = /^\((?:did not fit|over \d+|type changed|renamed with edits)[^:]*: (.+)\)$/.exec(line);
    const all = /^Did not fit, all in one call: (.+)$/.exec(line);
    if (all) calls.push(shell(cwd, all[1], shellWords(all[1]).slice(1)));
    if (!note || !file) continue;
    if (note[1] === 'read the file itself') calls.push({ call: `Bash: cat ${file}`, text: execFileSync('cat', [file], { cwd, encoding: 'utf8' }) });
    else calls.push(shell(cwd, note[1], shellWords(note[1]).slice(1)));
  }
  return calls;
}

const results = [];
const searches = [];
try {
  for (const scenario of ONLY === 'search' ? [] : SCENARIOS) {
    const cwd = path.join(tmp, scenario.id);
    const source = scenario.repo ?? ROOT;
    if (!existsSync(path.join(source, '.git'))) { console.log(`${scenario.id}: ${source} is not here, skipped`); continue; }
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', source, cwd]);
    const full = git(cwd, ['rev-parse', scenario.commit]).trim();
    git(cwd, ['checkout', '--quiet', '--detach', `${full}^`]);
    git(cwd, ['switch', '--quiet', '-c', 'work']);
    // The change as uncommitted work: the index stays at the parent, the
    // working tree becomes the commit — modified files unstaged, new files untracked.
    git(cwd, ['restore', '--source', full, '--worktree', '--', '.']);
    repos.splice(0, repos.length, { id: cwd, name: scenario.id, path: cwd, available: true });
    await openSession(cwd);
    const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);

    const tasks = [
      {
        id: 'summary', title: 'What changed?',
        git: [shell(cwd, 'git status', ['status']), shell(cwd, 'git diff --stat', ['diff', '--stat'])],
        twig: [await mcp('list_changes')]
      },
      {
        // What the commit-push skill reads before it writes a message (git
        // status, diff --stat, diff, log --oneline -10). git diff leaves out new
        // files, so the agent also reads each of them — with cat, the cheapest way.
        id: 'commit', title: 'Read everything to write the commit message',
        git: [
          shell(cwd, 'git status', ['status']),
          shell(cwd, 'git diff --stat', ['diff', '--stat']),
          shell(cwd, 'git diff', ['diff']),
          shell(cwd, 'git log --oneline -10', ['log', '--oneline', '-10']),
          ...untracked.map(file => ({ call: `Bash: cat ${file}`, text: execFileSync('cat', [file], { cwd, encoding: 'utf8' }) }))
        ],
        // 🌱 Twig has no history tool: git log --oneline is as small as a list of commits gets.
        twig: [await mcp('list_changes', { diffs: true }), shell(cwd, 'git log --oneline -10', ['log', '--oneline', '-10'])]
      }
    ];
    tasks[1].twig.splice(1, 0, ...readRest(cwd, tasks[1].twig[0].text));

    // The same change once committed: "explain this commit".
    git(cwd, ['add', '-A']);
    git(cwd, ['-c', 'user.name=m', '-c', 'user.email=m@m', 'commit', '--quiet', '-C', full]);
    tasks.push({
      id: 'explain', title: 'Explain a commit',
      git: [shell(cwd, 'git show HEAD', ['show', 'HEAD'])],
      twig: [await mcp('get_commit', { hash: 'HEAD' })]
    });
    tasks[2].twig.push(...readRest(cwd, tasks[2].twig[0].text));
    results.push({ ...scenario, tasks });
  }

  for (const scenario of ONLY === 'changes' ? [] : SEARCHES) {
    const source = scenario.repo ?? ROOT;
    if (!existsSync(path.join(source, '.git'))) { console.log(`${scenario.id}: ${source} is not here, skipped`); continue; }
    const cwd = await checkout(`search-${scenario.id}`, source, scenario.commit);
    const tasks = [];
    for (const query of scenario.queries) {
      const patch = git(cwd, ['log', `-S${query}`, '-p']);
      const pattern = new RegExp(`^(commit |diff --git )|${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      const twig = [];
      let cursor;
      do {
        const answer = await mcp('search_history', { query, ...(cursor ? { cursor } : {}) });
        twig.push(answer);
        cursor = /… more: search_history with cursor "(\d+)"\n$/.exec(answer.text)?.[1];
      } while (cursor);
      tasks.push({
        id: `search-${query}`, title: `When was ${query} added or removed?`,
        commits: git(cwd, ['log', `-S${query}`, '--format=%h']).trim().split('\n').filter(Boolean).length,
        git: [{ call: `Bash: git log -S'${query}' -p`, text: patch }],
        grep: [{ call: `Bash: git log -S'${query}' -p | grep -E -C3 '^(commit |diff --git )|${query}'`, text: grepContext(patch, pattern) }],
        twig
      });
    }
    for (const [file, start, end] of scenario.blames) {
      const range = start === null ? [] : ['-L', `${start},${end}`];
      const blame = git(cwd, ['blame', ...range, '--', file]);
      // Why: one `git log -1` per commit the blame names (a boundary ^hash is still a commit).
      const hashes = [...new Set(blame.split('\n').filter(Boolean).map(line => line.split(' ')[0].replace(/^\^/, '')))];
      tasks.push({
        id: `blame-${path.basename(file)}${start === null ? '' : `-${start}-${end}`}`,
        title: `Who changed ${file}${start === null ? '' : ` lines ${start}–${end}`} and why?`,
        commits: hashes.length,
        git: [shell(cwd, `git blame ${range.join(' ')}${range.length ? ' ' : ''}-- ${file}`, ['blame', ...range, '--', file]),
          ...hashes.map(hash => shell(cwd, `git log -1 ${hash}`, ['log', '-1', hash]))],
        twig: [await mcp('get_blame', { path: file, ...(start === null ? {} : { startLine: start, endLine: end }) })]
      });
    }
    searches.push({ ...scenario, repo: undefined, tasks });
  }

  const definitions = JSON.stringify(TOOLS.filter(tool => !['propose_commit', 'await_commit'].includes(tool.name)));

  // Every text the agent reads: the call it wrote, then the answer.
  const texts = [];
  const join = calls => calls.map(c => `${c.call}\n${c.text}`).join('\n');
  for (const scenario of [...results, ...searches]) {
    for (const task of scenario.tasks) {
      for (const side of ['git', 'grep', 'twig'].filter(key => task[key])) {
        const text = join(task[side]);
        task[side] = { calls: task[side].map(c => c.call), bytes: Buffer.byteLength(text), text };
        texts.push(task[side]);
      }
    }
  }
  const tools = { bytes: Buffer.byteLength(definitions), text: definitions };
  texts.push(tools);

  if (COUNT) {
    const tokensOf = text => {
      const out = execFileSync('claude', ['-p', '--setting-sources', '', '--system-prompt', 'Reply with the single word OK.', '--tools', '',
        '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json', '--model', MODEL],
      { input: text, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, cwd: tmp });
      const usage = JSON.parse(out).usage;
      return usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    };
    const empty = tokensOf('.');
    for (const entry of texts) entry.tokens = tokensOf(entry.text) - empty;
  }

  // Each set replaces only its own files, so one can be measured again without the other.
  await mkdir(OUT, { recursive: true });
  for (const file of await readdir(OUT)) {
    const search = file.startsWith('search-');
    if ((search && ONLY !== 'changes') || (!search && ONLY !== 'search')) await rm(path.join(OUT, file));
  }
  const rows = [];
  const unit = COUNT ? 'tokens' : 'bytes';
  const saved = (twig, other) => `${Math.round(100 - (twig / other) * 100)}%`;
  for (const [prefix, set] of [['', results], ['search-', searches]]) {
    for (const scenario of set) {
      for (const task of scenario.tasks) {
        for (const side of ['git', 'grep', 'twig'].filter(key => task[key])) await writeFile(path.join(OUT, `${prefix}${scenario.id}-${task.id}-${side}.txt`), task[side].text);
        rows.push({
          scenario: scenario.id, task: task.id,
          git: task.git[unit], ...(task.grep ? { 'git+grep': task.grep[unit] } : {}), twig: task.twig[unit],
          saved: saved(task.twig[unit], task.git[unit]), ...(task.grep ? { 'vs grep': saved(task.twig[unit], task.grep[unit]) } : {}),
          calls: `${task.git.calls.length} → ${task.twig.calls.length}`
        });
      }
    }
  }
  const strip = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'text'));
  const report = set => ({
    measuredAt: new Date().toISOString(), model: COUNT ? MODEL : null, unit,
    git: git(ROOT, ['--version']).trim(), toolDefinitions: strip(tools),
    scenarios: set.map(s => ({ ...s, tasks: s.tasks.map(t => ({ ...t, ...Object.fromEntries(['git', 'grep', 'twig'].filter(key => t[key]).map(key => [key, strip(t[key])])) })) }))
  });
  if (ONLY !== 'search') {
    await writeFile(path.join(OUT, 'tool-definitions.json'), definitions);
    await writeFile(path.join(OUT, 'results.json'), JSON.stringify(report(results), null, 2));
  }
  if (ONLY !== 'changes') await writeFile(path.join(OUT, 'search-results.json'), JSON.stringify(report(searches), null, 2));
  console.table(rows);
  console.log(`Tool definitions (${TOOLS.length - 2} tools without propose_commit and await_commit): ${COUNT ? `${tools.tokens} tokens` : `${tools.bytes} bytes`}`);
  console.log(`Texts: ${path.relative(ROOT, OUT)}/`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
