import { _electron as electron } from 'playwright';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Screenshots for the README and the landing site, taken from the real app on
// the seeded demo sandbox — the same repository a new user sees on first start,
// not a test fixture. Needs `npm run build` first. Raw PNGs land in
// artifacts/site-shots/; with `cwebp` on PATH they are also written as WebP into
// site/assets/shots/, which is what the README and the site reference.
//
// Nothing here asserts behaviour: the smoke scripts do that. This only drives
// the UI into presentable states and captures them.
const run = promisify(execFile);
// /tmp rather than the per-user temp dir on macOS: the console prints the cwd.
const profile = await mkdtemp(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'twig-demo-'));
const sandbox = path.join(profile, 'demo-sandbox');
const raw = path.resolve('artifacts/site-shots');
const published = path.resolve('site/assets/shots');
await mkdir(raw, { recursive: true });

const git = async (args, env = {}) => (await run('git', args, { cwd: sandbox, env: { ...process.env, ...env } })).stdout.trim();

let app;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 880));

  const history = page.getByRole('listbox', { name: 'Commit history', exact: true });
  await history.waitFor();
  await page.getByRole('heading', { name: 'Refine the workspace layout' }).waitFor();

  const oids = new Map((await git(['log', '--all', '--exclude=refs/stash', '--format=%H %s']))
    .split('\n').map(line => [line.slice(41), line.slice(0, 40)]));
  const row = subject => page.locator(`#commit-${oids.get(subject)}`);
  const demoId = await page.evaluate(() => window.twig.getWorkspace().then(w => w.repositories.find(r => r.sandbox).id));
  const consoleBar = page.locator('.console-status');
  const consoleOpen = () => page.getByRole('textbox', { name: 'Run a read-only git command' }).count().then(Boolean);
  const setConsole = async open => { if (await consoleOpen() !== open) await consoleBar.click(); };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const theme = async name => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(name);
    await page.keyboard.press('Escape');
  };
  const shot = async name => {
    // Transient notes ("Staged README.md.") are not what the picture is about.
    for (const note of await page.locator('.operation-note button[aria-label="Dismiss"]').all()) await note.click();
    await settle();
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(raw, `${name}.png`), animations: 'disabled' });
    console.log(`  ${name}.png`);
  };

  await theme('dark');

  // Local marks: a colour and a note on two commits. They live in userData,
  // never in the repository; Refresh reads them back like any other reload.
  await page.evaluate(([id, a, b]) => Promise.all([
    window.twig.setMark(id, a, 'green', 'Ready for review: focus moves through the commit panel with the arrows.'),
    window.twig.setMark(id, b, 'amber', 'Shipped as v0.0.2 — recheck tab restore before the next release.')
  ]), [demoId, oids.get('Add keyboard navigation to commit details'), oids.get('Merge branch feature/repository-tabs')]);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await row('Merge branch feature/repository-tabs').locator('.mark-chip').waitFor();

  // Console: a typed read-only command, its entry expanded with the output.
  await setConsole(true);
  await page.getByRole('button', { name: 'My', exact: true }).click().catch(() => {});
  const input = page.getByRole('textbox', { name: 'Run a read-only git command' });
  await input.fill('log --oneline --graph --branches -12');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('article').filter({ hasText: 'log --oneline --graph --branches -12' }).first().waitFor();
  await page.waitForFunction(() => document.querySelector('.console-command')?.value === '');
  await row('Add keyboard navigation to commit details').click();
  await page.getByRole('heading', { name: 'Add keyboard navigation to commit details' }).waitFor();
  await shot('console');
  await setConsole(false);

  // Hero: the graph, a marked commit open with its details.
  const details = page.getByRole('button', { name: 'Show details', exact: true });
  if (await details.count()) await details.click();
  await shot('workspace');
  await theme('light');
  await shot('workspace-light');
  await theme('dark');

  // Uncommitted work: the strip over the graph and the panel beside it.
  // README goes into the index from the panel's plus, then gets one more edit
  // on disk, so all three lists have something in them.
  await page.getByRole('button', { name: /Uncommitted changes/ }).click();
  const uncommitted = page.getByRole('complementary', { name: 'Uncommitted changes', exact: true });
  await uncommitted.waitFor();
  await uncommitted.getByRole('button', { name: 'Stage README.md', exact: true }).click();
  await uncommitted.getByRole('button', { name: 'Unstage README.md', exact: true }).waitFor();
  await appendFile(path.join(sandbox, 'README.md'), 'Open the Uncommitted strip to stage from the side panel.\n');
  await writeFile(path.join(sandbox, 'workspace.js'), (await readFile(path.join(sandbox, 'workspace.js'), 'utf8')) + '\nexport const detailsWidth = 320;\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await uncommitted.getByRole('button', { name: 'Stage workspace.js', exact: true }).waitFor();
  await shot('uncommitted');

  // File history of app/App.jsx with the per-commit diff, line numbers included.
  await row('Add keyboard navigation to commit details').click();
  await page.getByRole('heading', { name: 'Add keyboard navigation to commit details' }).waitFor();
  const appFile = page.getByRole('button', { name: /^Modified .*App\.jsx$/ });
  await appFile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'File history' }).click();
  const fileHistory = page.getByRole('region', { name: 'File history', exact: true });
  await fileHistory.getByRole('listitem').first().getByRole('button').click();
  await page.getByRole('region', { name: 'File diff', exact: true }).locator('.diff-added').first().waitFor();
  await shot('file-history');
  await page.getByRole('button', { name: 'Close file history' }).click().catch(() => page.keyboard.press('Escape'));

  // Blame of the same file at the tip, a line picked so the detail shows.
  await history.waitFor();
  await row('Add keyboard navigation to commit details').click();
  await appFile.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Blame history' }).click();
  const grid = page.getByRole('grid', { name: 'Blame lines', exact: true });
  await grid.getByRole('row').last().click();
  await page.waitForTimeout(400);
  await shot('blame');
  await page.getByRole('region', { name: 'Blame', exact: true }).getByRole('button', { name: /Close/ }).first().click();

  // Automations: a pipeline built from a template, then one that blocks.
  await history.waitFor();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('region', { name: 'Automations', exact: true }).waitFor();
  await page.getByLabel('Add from template').selectOption('js-ts');
  await page.getByRole('button', { name: 'Add action', exact: true }).waitFor();
  await shot('automations-editor');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Add from template').selectOption('protect-main');
  await page.getByRole('button', { name: 'Save pipeline', exact: true }).click();
  await page.locator('.pipeline-card').filter({ hasText: 'Protect main' }).waitFor();
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByText('Commit blocked').waitFor();
  await shot('automations-blocked');
  await page.getByRole('button', { name: 'Close', exact: true }).first().click().catch(() => page.keyboard.press('Escape'));
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await history.waitFor();

  // BugHunter needs a clean tree: park the demo edits in a stash first.
  await git(['stash', 'push', '--include-untracked', '-m', 'WIP: README wording and notes']);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.uncommitted-row, [class*="uncommitted-strip"]'), null, { timeout: 5000 }).catch(() => {});
  await row('Refine the workspace layout').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /BugHunter \(bisect\)/ }).click();
  const hunter = page.getByRole('region', { name: '🌱 BugHunter (bisect)', exact: true });
  await hunter.waitFor();
  await row('Set up the desktop application').click();
  await hunter.getByRole('button', { name: /^Bug absent at / }).click();
  await hunter.getByText(/Testing [0-9a-f]{7}/).waitFor();
  await hunter.getByRole('button', { name: 'Show test commit', exact: true }).click();
  await page.getByRole('heading', { name: 'Remember selection for each tab' }).waitFor();
  await shot('bughunter');
  await hunter.getByRole('button', { name: /Stop and return|Finish and return/ }).click();
  await hunter.waitFor({ state: 'detached' });

  // A conflicting merge. feature/command-log gets a commit that edits the same
  // lines of app/App.jsx that main rewrote — made with a temporary index so the
  // working tree is untouched — and the merge is started from a terminal: the
  // watcher picks the stopped merge up the way it would in real use.
  const index = path.join(profile, 'shot-index');
  const indexEnv = { GIT_INDEX_FILE: index };
  await git(['read-tree', 'feature/command-log'], indexEnv);
  const content = "export function App() {\n  return 'workspace';\n}\n\nexport const remembersTabs = true;\nexport const consoleDock = 'bottom';\n";
  await writeFile(path.join(profile, 'App.jsx'), content);
  const blob = await git(['hash-object', '-w', path.join(profile, 'App.jsx')]);
  await git(['update-index', '--cacheinfo', `100644,${blob},app/App.jsx`], indexEnv);
  const tree = await git(['write-tree'], indexEnv);
  const when = new Date(Date.now() - 20 * 86400000).toISOString();
  const author = { GIT_AUTHOR_NAME: 'Alex Morgan', GIT_AUTHOR_EMAIL: 'alex@twig.example', GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: 'Alex Morgan', GIT_COMMITTER_EMAIL: 'alex@twig.example', GIT_COMMITTER_DATE: when };
  const commit = await git(['commit-tree', tree, '-p', 'feature/command-log', '-m', 'Dock the console at the bottom'], author);
  await git(['update-ref', 'refs/heads/feature/command-log', commit]);
  await git(['merge', '--no-ff', '--no-edit', 'feature/command-log']).catch(() => {});
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('status', { name: 'Merge in progress' }).waitFor();
  await page.getByRole('button', { name: /App\.jsx Resolve/ }).click();
  const editor = page.getByRole('region', { name: /Resolve conflict in .*App\.jsx/ });
  await editor.waitFor();
  const region = editor.locator('.conflict-region').first();
  await region.getByRole('checkbox', { name: 'Take ours line 1' }).check();
  await region.getByRole('checkbox', { name: 'Take theirs line 2' }).check();
  await shot('conflict');
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}

// WebP for the page: the same pixels at a fraction of the PNG weight.
try {
  await run('cwebp', ['-version']);
  await mkdir(published, { recursive: true });
  for (const file of (await readdir(raw)).filter(name => name.endsWith('.png'))) {
    await run('cwebp', ['-quiet', '-q', '88', '-m', '6', path.join(raw, file), '-o', path.join(published, file.replace(/\.png$/, '.webp'))]);
  }
  console.log(`WebP written to ${path.relative(process.cwd(), published)}/`);
} catch {
  console.log('cwebp not found: PNGs left in artifacts/site-shots/ only.');
}
