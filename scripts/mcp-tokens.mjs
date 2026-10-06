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
//
// Scenarios are real changes from this repository's own history: the parent
// commit is checked out in a throwaway clone and the change is put back as
// uncommitted work (modified files unstaged, new files untracked) — the state
// an agent finds when it is asked to commit it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const SCENARIOS = [
  { id: 'small', commit: 'fdfdeb6', label: 'Bug fix: 4 files, +80 −2' },
  { id: 'medium', commit: '5bb7b12', label: 'Feature: 7 files, +154 −7' },
  { id: 'large', commit: '672a8b8', label: 'Large feature: 28 files, +1048 −44' },
  // A new dependency: the same kind of change, with package-lock.json in it.
  // From another project of ours (a TypeScript game); skipped where it is absent.
  { id: 'dependency', repo: path.join(os.homedir(), 'projects/garden'), commit: 'dde8126', label: 'Feature + dependency: 14 files, +726 −41, 131 of them in package-lock.json' }
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

/** The path of a `## M +2 -1 path` file line (the new name of a rename), or null. */
function filePath(line) {
  const match = line.match(/^## \S (?:bin|\+\d+ -\d+) (.+)$/);
  if (!match) return null;
  const name = match[1].includes(' -> ') ? match[1].split(' -> ').pop() : match[1];
  return name.startsWith('"') ? JSON.parse(name) : name;
}

/**
 * What an answer left out — a file that "did not fit" or is too long, or a
 * hunk marked "not shown" — read the way the tool descriptions say, so the agent ends up
 * knowing as much as from the git output it is compared with.
 * @param {string} text  @param {(file: string) => object} readFile  @param {(file: string, id: string) => object} readHunk
 */
async function readRest(text, readFile, readHunk) {
  const calls = [];
  let file = null;
  for (const line of text.split('\n')) {
    file = filePath(line) ?? file;
    const hunk = line.match(/\[([a-z]\d+-[0-9a-f]{8}): [^\]]*not shown\]$/);
    if (hunk && file) calls.push(await readHunk(file, hunk[1]));
    // Lock and generated files stay unread: the reason they are left out is
    // that nobody reads them — but `git diff` hands them over all the same.
    else if (/^\((did not fit|over \d+|type changed|renamed with edits)/.test(line) && file) {
      const whole = await readFile(file);
      calls.push(whole, ...await readRest(whole.text, readFile, readHunk));
    }
  }
  return calls;
}

const results = [];
try {
  for (const scenario of SCENARIOS) {
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
        twig: [await mcp('list_changes', { diffs: true }), await mcp('get_history', { limit: 10 })]
      }
    ];
    const commitTwig = tasks[1].twig;
    commitTwig.push(...await readRest(commitTwig[0].text,
      file => mcp('get_diff', { path: file }), (file, hunkId) => mcp('get_diff_hunk', { path: file, hunkId })));

    // The same change once committed: "explain this commit".
    git(cwd, ['add', '-A']);
    git(cwd, ['-c', 'user.name=m', '-c', 'user.email=m@m', 'commit', '--quiet', '-C', full]);
    tasks.push({
      id: 'explain', title: 'Explain a commit',
      git: [shell(cwd, 'git show HEAD', ['show', 'HEAD'])],
      twig: [await mcp('get_commit', { hash: 'HEAD' }), await mcp('get_commit_diff', { hash: 'HEAD' })]
    });
    const explainTwig = tasks[2].twig;
    explainTwig.push(...await readRest(explainTwig[1].text,
      file => mcp('get_commit_diff', { hash: 'HEAD', path: file }), (file, hunkId) => mcp('get_commit_diff', { hash: 'HEAD', path: file, hunkId })));
    results.push({ ...scenario, tasks });
  }

  const definitions = JSON.stringify(TOOLS.filter(tool => !['propose_commit', 'await_commit'].includes(tool.name)));

  // Every text the agent reads: the call it wrote, then the answer.
  const texts = [];
  const join = calls => calls.map(c => `${c.call}\n${c.text}`).join('\n');
  for (const scenario of results) {
    for (const task of scenario.tasks) {
      for (const side of ['git', 'twig']) {
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

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const rows = [];
  for (const scenario of results) {
    for (const task of scenario.tasks) {
      for (const side of ['git', 'twig']) await writeFile(path.join(OUT, `${scenario.id}-${task.id}-${side}.txt`), task[side].text);
      const unit = COUNT ? 'tokens' : 'bytes';
      rows.push({
        scenario: scenario.id, task: task.id,
        git: task.git[unit], twig: task.twig[unit],
        saved: `${Math.round(100 - (task.twig[unit] / task.git[unit]) * 100)}%`,
        calls: `${task.git.calls.length} → ${task.twig.calls.length}`
      });
    }
  }
  await writeFile(path.join(OUT, 'tool-definitions.json'), definitions);
  const strip = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'text'));
  await writeFile(path.join(OUT, 'results.json'), JSON.stringify({
    measuredAt: new Date().toISOString(), model: COUNT ? MODEL : null, unit: COUNT ? 'tokens' : 'bytes',
    git: git(ROOT, ['--version']).trim(), toolDefinitions: strip(tools),
    scenarios: results.map(s => ({ ...s, tasks: s.tasks.map(t => ({ ...t, git: strip(t.git), twig: strip(t.twig) })) }))
  }, null, 2));
  console.table(rows);
  console.log(`Tool definitions (9 read tools): ${COUNT ? `${tools.tokens} tokens` : `${tools.bytes} bytes`}`);
  console.log(`Texts: ${path.relative(ROOT, OUT)}/`);
} finally {
  await rm(tmp, { recursive: true, force: true });
}
