import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';

/**
 * The demo tab is a real Git repository, not a mock: Twig creates it under
 * `userData/` and seeds it with a scripted history so every command — checkout,
 * merge, rebase, stash, blame, automations, the console, Undo/Redo — works
 * exactly as it does for a connected repository. Nothing here reaches the
 * network: the "remote" is a local bare repository beside the sandbox.
 */
export const SANDBOX_DIRNAME = 'demo-sandbox';
export const SANDBOX_REMOTE_DIRNAME = 'demo-sandbox-remote.git';
export const SANDBOX_MARKER_FILE = 'demo-sandbox.json';
export const SANDBOX_NAME = 'workspace-demo';
/** Bump to force existing installs to re-seed on the next launch. */
export const SEED_VERSION = 1;

const AUTHORS = {
  maya: { name: 'Maya Chen', email: 'maya@twig.example' },
  alex: { name: 'Alex Morgan', email: 'alex@twig.example' },
  sam: { name: 'Sam Rivera', email: 'sam@twig.example' }
};

const README = `# workspace-demo

A real sandbox repository. Everything you do here runs system Git against
this folder — try a checkout, a merge, an interactive rebase, or the console.

Reset it any time from Settings -> Reset demo workspace.
`;

const WORKSPACE = `export const panels = ['history', 'details', 'console'];

export function layout(width) {
  return width < 1000 ? 'compact' : 'full';
}
`;

const APP = `export function App() {
  return 'workspace';
}
`;

const TOKENS = `:root {
  --space-4: 16px;
  --radius-sm: 4px;
}
`;

const CONSOLE = `export function streamOutput(chunk, onData) {
  onData(chunk.toString('utf8'));
}
`;

/**
 * The scripted history, oldest commit first. Pure data so a check can assert
 * the shape without running Git; `runSeed` is the only place it is executed.
 * `daysAgo` backdates the commit so the age ramp has roots and fresh work.
 */
export function sandboxPlan() {
  return {
    branch: 'main',
    commits: [
      { key: 'setup', author: 'maya', daysAgo: 320, message: 'Set up the desktop application',
        write: { 'README.md': README, 'workspace.js': WORKSPACE } },
      { key: 'shell', author: 'maya', daysAgo: 300, message: 'Create the first workspace shell',
        write: { 'app/App.jsx': APP }, tag: 'v0.0.1' },
      { key: 'surfaces', author: 'maya', daysAgo: 262, message: 'Define light and dark surface colors',
        write: { 'ui/tokens.css': TOKENS } },
      { key: 'folders', author: 'sam', daysAgo: 210, message: 'Group branch names into folders',
        write: { 'workspace.js': WORKSPACE + "\nexport const groupByFolder = true;\n" } },
      { key: 'tabs-remember', author: 'sam', daysAgo: 160, branch: 'feature/repository-tabs', from: 'folders',
        message: 'Remember selection for each tab', write: { 'app/App.jsx': APP + "\nexport const remembersTabs = true;\n" } },
      { key: 'tabs-close', author: 'sam', daysAgo: 150, message: 'Add close controls to workspace tabs',
        write: { 'app/App.jsx': APP + "\nexport const remembersTabs = true;\nexport const closableTabs = true;\n" } },
      { key: 'merge-tabs', author: 'maya', daysAgo: 140, checkout: 'main', merge: 'feature/repository-tabs',
        message: 'Merge branch feature/repository-tabs', tag: 'v0.0.2' },
      { key: 'log-stream', author: 'alex', daysAgo: 92, branch: 'feature/command-log', from: 'merge-tabs',
        message: 'Stream command output as it arrives', write: { 'app/console.js': CONSOLE } },
      { key: 'log-duration', author: 'alex', daysAgo: 60, message: 'Add duration to command entries',
        write: { 'app/console.js': CONSOLE + "\nexport const showsDuration = true;\n" } },
      { key: 'fonts', author: 'maya', daysAgo: 28, checkout: 'main',
        message: 'Use local fonts throughout the app', write: { 'ui/tokens.css': TOKENS + "  --font-ui: 'Fira Sans';\n" } },
      { key: 'keyboard', author: 'maya', daysAgo: 3, message: 'Add keyboard navigation to commit details',
        write: { 'app/App.jsx': APP + "\nexport const keyboardNav = true;\n" }, publish: true },
      { key: 'layout', author: 'maya', daysAgo: 1, message: 'Refine the workspace layout',
        write: { 'README.md': README + "\nKeep the details close to the history.\n" } }
    ],
    // Left in the working tree after seeding so the worktree screen is not empty.
    stash: { message: 'WIP: try a narrower sidebar', write: { 'workspace.js': WORKSPACE + "\nexport const sidebarWidth = 180;\n" } },
    dirty: { 'README.md': README + "\nKeep the details close to the history.\nOne unstaged edit.\n" },
    untracked: { 'notes.todo': "- try the reverse blame view\n- run the demo automation\n" }
  };
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function writeFiles(dir, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/** Seed a fresh sandbox repository and its local bare remote. */
export async function runSeed({ dir, remoteDir, log }) {
  await mkdir(dir, { recursive: true });
  const git = async (argv, extraEnv = null) => {
    const result = await runGit({ argv, cwd: dir, log, operation: 'Seed demo workspace', env: extraEnv });
    if (result.code !== 0) throw new Error(`Seed step failed: git ${argv.join(' ')}\n${result.stderr}`);
    return result.stdout.trimEnd();
  };

  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Maya Chen']);
  await git(['config', 'user.email', 'maya@twig.example']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'tag.gpgsign', 'false']);
  await git(['config', 'core.hooksPath', '']);

  const plan = sandboxPlan();
  const tips = new Map();
  let current = 'main';

  for (const commit of plan.commits) {
    if (commit.branch && commit.from) {
      await git(['checkout', '-b', commit.branch, tips.get(commit.from)]);
      current = commit.branch;
    } else if (commit.checkout && commit.checkout !== current) {
      await git(['checkout', commit.checkout]);
      current = commit.checkout;
    }

    const date = isoDaysAgo(commit.daysAgo);
    const person = AUTHORS[commit.author];
    const env = {
      GIT_AUTHOR_NAME: person.name, GIT_AUTHOR_EMAIL: person.email,
      GIT_COMMITTER_NAME: person.name, GIT_COMMITTER_EMAIL: person.email,
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date
    };

    if (commit.merge) {
      await git(['merge', '--no-ff', '-m', commit.message, commit.merge], env);
    } else {
      await writeFiles(dir, commit.write);
      await git(['add', '--all']);
      await git(['commit', '-m', commit.message], env);
    }
    tips.set(commit.key, await git(['rev-parse', 'HEAD']));
    if (commit.tag) await git(['tag', commit.tag]);
    if (commit.publish) {
      await git(['init', '--bare', '--initial-branch=main', remoteDir]);
      await git(['remote', 'add', 'origin', remoteDir]);
      await git(['push', '--set-upstream', 'origin', 'main']);
      await git(['push', 'origin', '--tags']);
    }
  }

  if (current !== 'main') await git(['checkout', 'main']);
  await writeFiles(dir, plan.stash.write);
  await git(['stash', 'push', '-m', plan.stash.message]);
  await writeFiles(dir, plan.dirty);
  await writeFiles(dir, plan.untracked);
}

/** Wipe the sandbox and its remote, then seed both again. */
export async function resetSandbox({ dir, remoteDir, log }) {
  await rm(dir, { recursive: true, force: true });
  await rm(remoteDir, { recursive: true, force: true });
  await runSeed({ dir, remoteDir, log });
}

async function exists(target) {
  try { await access(target); return true; } catch { return false; }
}

/**
 * Fast path on launch: seed only when the repository is missing or was seeded
 * by an older `SEED_VERSION`. The marker lives outside the repository so it is
 * never an untracked file inside the demo.
 */
export async function ensureSandbox({ dir, remoteDir, markerFile, log }) {
  let seeded = false;
  if (await exists(path.join(dir, '.git'))) {
    try {
      const marker = JSON.parse(await readFile(markerFile, 'utf8'));
      seeded = marker?.version === SEED_VERSION;
    } catch { seeded = false; }
  }
  if (seeded) return;
  await resetSandbox({ dir, remoteDir, log });
  await writeFile(markerFile, JSON.stringify({ version: SEED_VERSION, seededAt: new Date().toISOString() }, null, 2), 'utf8');
}
