import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// Drives M4 in a real Electron window: the commit context menu, a merge that
// conflicts, the three-way conflict editor, the interrupted-operation banner,
// a destructive confirmation, an interactive rebase and rewording a commit
// both on the tip and from inside the history.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-ops-smoke-'));
let app;
try {
  const cwd = path.join(root, 'ops-fixture');
  await mkdir(cwd);
  const log = new CommandLog(root);
  await log.load();
  const git = async (argv, at = cwd) => {
    // The running app reads the repository on its own (history, refs, the
    // automation engine's context gathering), and a concurrent `git status`
    // there can briefly hold `.git/index.lock`. A shell mutation racing it is
    // retried rather than treated as a real failure.
    let result;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = await runGit({ argv, cwd: at, log });
      if (result.code === 0 || !/index\.lock/.test(result.stderr)) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };

  await git(['init', '--initial-branch=main', cwd], root);
  for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);

  await writeFile(path.join(cwd, 'poem.txt'), 'roses\nviolets\nsugar\n', 'utf8');
  await git(['add', '--', ':(literal)poem.txt']);
  await git(['commit', '--message', 'plant the garden']);

  await git(['checkout', '-b', 'feature', '--']);
  await writeFile(path.join(cwd, 'poem.txt'), 'roses\nFEATURE\nsugar\n', 'utf8');
  await git(['commit', '--all', '--message', 'feature rewrites the middle']);
  await git(['checkout', 'main', '--']);
  await writeFile(path.join(cwd, 'poem.txt'), 'roses\nTRUNK\nsugar\n', 'utf8');
  await git(['commit', '--all', '--message', 'trunk rewrites the middle']);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);

  await mkdir('artifacts', { recursive: true });
  const shot = name => page.screenshot({ path: `artifacts/m4-${name}.png`, animations: 'disabled' });

  const expect = async (text, description) => {
    try {
      await page.getByText(text, { exact: true }).waitFor();
    } catch (failure) {
      const shown = await page.locator('[role="alert"], [role="status"], .history-error, .operation-note').allInnerTexts();
      throw new Error(`${description}: expected "${text}". On screen: ${JSON.stringify(shown)}. Page errors: ${JSON.stringify(errors)}. ${failure.message}`);
    }
  };

  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();

  // --- the context menu ------------------------------------------------------
  const featureRow = page.getByRole('option', { name: /feature rewrites the middle/ });
  await featureRow.click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  // Only what applies: the branch that is checked out is never offered to
  // itself, and rebasing onto the tip of the current branch is not offered.
  await menu.getByRole('menuitem', { name: 'Merge feature into main', exact: true }).waitFor();
  assert.equal(await menu.getByRole('menuitem', { name: /Merge main into/ }).count(), 0);
  // The ref that sits on this commit brings its own actions: rename, upstream, delete.
  await menu.getByRole('menuitem', { name: 'Rename feature…', exact: true }).waitFor();
  await menu.getByRole('menuitem', { name: 'Delete feature', exact: true }).waitFor();
  await shot('menu');

  // Escape closes it and focus goes back to the history, not to the top of the page.
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });

  // Create a throwaway branch from the menu on a commit that main already
  // contains, then delete it from the menu: the whole ref-action path (menu
  // item → §6.5 dialog → refs:delete-branch → graph reload) runs against real
  // Git, and `branch -d` accepts it because nothing would be lost.
  const gardenRow = page.getByRole('option', { name: /plant the garden/ });
  await gardenRow.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Create branch here…', exact: true }).click();
  await page.getByLabel('Branch name').fill('scratch');
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  await expect('Branch scratch created.', 'the scratch branch is created');
  await gardenRow.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Delete scratch', exact: true }).click();
  await expect('Branch scratch deleted.', 'the scratch branch is deleted from the menu');
  assert.equal(await page.getByRole('option', { name: /\bscratch\b/ }).count(), 0, 'the deleted branch is gone from the graph');

  // The same menu is reachable without a mouse.
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).focus();
  await page.keyboard.press('Shift+F10');
  await menu.waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });

  // --- a merge that conflicts, resolved in the editor -------------------------
  await featureRow.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Merge feature into main', exact: true }).click();
  await page.getByRole('status', { name: 'Merge in progress' }).waitFor();
  await expect('1 file still conflicted.', 'the banner counts the conflict');

  // Continue is refused while anything is still conflicted.
  const advance = page.getByRole('button', { name: /^Continue/ });
  assert.equal(await advance.isDisabled(), true, 'Continue must wait for the conflicts');

  await page.getByRole('button', { name: 'poem.txt Resolve' }).click();
  const editor = page.getByRole('region', { name: 'Resolve conflict in poem.txt' });
  await editor.waitFor();
  await expect('1 conflict left', 'the editor counts the region');

  // A stopped merge is not a failure: the banner explains it, so no error
  // note is raised and the console is not forced open behind the user's back.
  assert.equal(await page.locator('.operation-note').count(), 0);

  // Both sides are on screen, taken from the index rather than from the markers.
  await editor.getByRole('group', { name: 'Ours — the whole file' }).count();
  const result = editor.getByRole('textbox', { name: /Result/ });

  // Reviewed with the console collapsed: that is the height the editor really
  // gets when someone is working in it.
  const terminal = page.locator('.console-status');
  await terminal.click();
  await shot('conflict');
  await terminal.click();
  assert.match(await result.inputValue(), /<<<<<<</, 'the result starts as the file Git wrote');

  // Take one line from each side, in an order the user chose.
  const region = editor.locator('.conflict-region').first();
  await region.getByRole('checkbox', { name: 'Take ours line 1' }).check();
  await region.getByRole('checkbox', { name: 'Take theirs line 1' }).check();
  await region.getByRole('combobox', { name: 'Order' }).selectOption('theirs');
  await region.getByRole('button', { name: /^Apply 2 selected lines/ }).click();
  assert.equal(await result.inputValue(), 'roses\nFEATURE\nTRUNK\nsugar\n', 'theirs first, then ours, and nothing else touched');

  // Undo inside the editor is the editor's own, and puts the markers back.
  await editor.getByRole('button', { name: 'Undo in the conflict editor' }).click();
  assert.match(await result.inputValue(), /<<<<<<</);
  await editor.getByRole('button', { name: 'Redo in the conflict editor' }).click();
  assert.equal(await result.inputValue(), 'roses\nFEATURE\nTRUNK\nsugar\n');

  await editor.getByRole('button', { name: /^Save and mark resolved/ }).click();
  await expect('poem.txt marked resolved.', 'saving the resolution');
  await expect('Nothing is conflicted any more. Continue to finish it.', 'the banner after resolving');
  assert.equal(await readFile(path.join(cwd, 'poem.txt'), 'utf8'), 'roses\nFEATURE\nTRUNK\nsugar\n');

  await page.getByRole('button', { name: /^Continue/ }).click();
  await page.getByRole('status', { name: 'Merge in progress' }).waitFor({ state: 'detached' });
  assert.equal((await git(['rev-list', '--parents', '-1', 'HEAD'])).split(' ').length, 3, 'a real merge commit');

  // --- a destructive confirmation ---------------------------------------------
  const before = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(cwd, 'poem.txt'), 'roses\nSCRATCH\nsugar\n', 'utf8');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const first = page.getByRole('option', { name: /plant the garden/ });
  await first.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Reset main to .* — hard/ }).click();
  const confirm = page.getByRole('dialog');
  await confirm.waitFor();
  // §6.5: the exact command and what is lost, both spelled out.
  await expect('This command will run:', 'the confirmation shows the command');
  assert.match(await confirm.locator('.confirm-command').innerText(), /^\$ git reset --hard [0-9a-f]{40}$/);
  assert.match(await confirm.locator('.confirm-consequence').innerText(), /destroyed/);
  await shot('confirm');

  // Cancelling really does nothing.
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirm.waitFor({ state: 'detached' });
  assert.equal(await git(['rev-parse', 'HEAD']), before, 'cancel did not reset anything');
  assert.equal(await readFile(path.join(cwd, 'poem.txt'), 'utf8'), 'roses\nSCRATCH\nsugar\n');

  // --- interactive rebase -------------------------------------------------------
  await git(['checkout', '--', ':(literal)poem.txt']);
  await git(['checkout', '-b', 'plan', '--']);
  for (const name of ['alpha', 'beta']) {
    await writeFile(path.join(cwd, `${name}.txt`), `${name}\n`, 'utf8');
    await git(['add', '--', `:(literal)${name}.txt`]);
    await git(['commit', '--message', `add ${name}`]);
  }
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('option', { name: /add beta/ }).waitFor();
  // Refresh re-reads the repository too: the branch was switched outside the
  // window, and every menu label is phrased in terms of the current branch.
  await page.getByRole('region', { name: 'Git actions' }).getByRole('button', { name: 'plan', exact: true }).waitFor();

  // Rebase from the merge commit, so the plan is exactly the two new commits.
  await page.getByRole('option', { name: /Merge branch/ }).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Rebase plan interactively from/ }).click();
  const rebase = page.getByRole('dialog');
  await rebase.waitFor();
  await expect('Interactive rebase', 'the rebase dialog opens');

  // Reorder without a mouse, then drop one commit.
  await rebase.getByRole('button', { name: 'Move add beta earlier' }).click();
  const rows = rebase.locator('.rebase-row');
  assert.match(await rows.first().innerText(), /add beta/, 'the plan really reordered');
  await rows.nth(1).getByRole('combobox').selectOption('reword');
  await rebase.getByRole('textbox', { name: /New message for/ }).fill('add alpha, renamed by the plan');
  await shot('rebase');
  await rebase.getByRole('button', { name: 'Start rebase', exact: true }).click();
  await expect('Rebase finished.', 'the interactive rebase runs to the end');

  assert.deepEqual((await git(['log', '--format=%s', '-2'])).split('\n'),
    ['add alpha, renamed by the plan', 'add beta'],
    'Git replayed the plan Twig supplied, in the order shown, with the new message');

  // --- rewording ---------------------------------------------------------------
  // Something is staged on purpose: `--amend` alone would swallow it into the
  // commit whose message was being fixed.
  await writeFile(path.join(cwd, 'staged.txt'), 'not part of that commit\n', 'utf8');
  await git(['add', '--', ':(literal)staged.txt']);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('option', { name: /add alpha, renamed by the plan/ }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Reword / }).click();
  const reword = page.getByRole('dialog');
  await reword.waitFor();
  assert.equal(await reword.locator('.confirm-command').innerText(), '$ git commit --amend --only --file=-');
  assert.match(await reword.locator('.confirm-consequence').innerText(), /staged is left out/);
  const messageBox = reword.getByRole('textbox', { name: 'Commit message' });
  assert.equal(await messageBox.inputValue(), 'add alpha, renamed by the plan', 'the dialog opens on the message it has');
  await shot('reword');
  await messageBox.fill('add alpha, reworded on the tip');
  await reword.getByRole('button', { name: 'Rewrite the message', exact: true }).click();
  await expect('Message rewritten.', 'the tip commit is reworded');
  assert.equal(await git(['log', '-1', '--format=%s']), 'add alpha, reworded on the tip');
  assert.deepEqual((await git(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean), ['staged.txt'],
    'the staged file stayed staged instead of joining the reworded commit');

  // An older commit is reworded by replaying the range, which needs the clean
  // tree a rebase needs — the menu says so before the click.
  await page.getByRole('option', { name: /add beta/ }).click({ button: 'right' });
  assert.match(await menu.getByRole('menuitem', { name: /^Reword / }).getAttribute('title'), /stash/);
  await page.keyboard.press('Escape');
  await git(['reset', '--', ':(literal)staged.txt']);
  await rm(path.join(cwd, 'staged.txt'), { force: true });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();

  await page.getByRole('option', { name: /add beta/ }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Reword / }).click();
  const replay = page.getByRole('dialog');
  await replay.waitFor();
  assert.match(await replay.locator('.confirm-command').innerText(), /^\$ git rebase --interactive [0-9a-f]{40}$/);
  assert.match(await replay.locator('.confirm-consequence').innerText(), /the one commit after it/);
  await replay.getByRole('textbox', { name: 'Commit message' }).fill('add beta, reworded from inside the history');
  await replay.getByRole('button', { name: 'Rewrite and replay', exact: true }).click();
  await expect('Message rewritten.', 'an older commit is reworded by replaying the range');
  assert.deepEqual((await git(['log', '--format=%s', '-2'])).split('\n'),
    ['add alpha, reworded on the tip', 'add beta, reworded from inside the history'],
    'only the targeted message changed; the commit after it was replayed as it was');
  assert.equal(await readFile(path.join(cwd, 'alpha.txt'), 'utf8'), 'alpha\n', 'the replayed content is untouched');

  // --- squashing a run of selected commits --------------------------------
  // Three adjacent commits, two of them picked with Cmd/Ctrl-click; the
  // context menu on the selection folds them into one and leaves the third.
  await git(['checkout', '-b', 'squash-demo', '--']);
  for (const name of ['sq1', 'sq2', 'sq3']) {
    await writeFile(path.join(cwd, `${name}.txt`), `${name}\n`, 'utf8');
    await git(['add', '--', `:(literal)${name}.txt`]);
    await git(['commit', '--message', `add ${name}`]);
  }
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  // A non-adjacent pair (sq1 and sq3, skipping sq2) offers no Squash item.
  await page.getByRole('option', { name: /add sq1/ }).click();
  await page.getByRole('option', { name: /add sq3/ }).click({ modifiers: ['ControlOrMeta'] });
  assert.equal(await page.locator('.real-commit-row.multi-selected, .real-commit-row.selected').count(), 2,
    'both commits show as selected');
  await page.getByRole('option', { name: /add sq3/ }).click({ button: 'right' });
  await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem', { name: /Squash/ }).count(), 0,
    'a gap in the selection hides Squash');
  await page.keyboard.press('Escape');
  // An adjacent pair (sq1 then sq2) does offer it.
  await page.getByRole('option', { name: /add sq1/ }).click();
  await page.getByRole('option', { name: /add sq2/ }).click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('option', { name: /add sq2/ }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Squash 2 commits into one/ }).click();
  const squash = page.getByRole('dialog');
  await squash.waitFor();
  assert.match(await squash.locator('.confirm-command').innerText(), /^\$ git rebase --interactive [0-9a-f]{7}$/);
  await squash.getByRole('textbox', { name: 'Message for the squashed commit' }).fill('sq1 and sq2, squashed');
  await squash.getByRole('button', { name: 'Squash and replay', exact: true }).click();
  await expect('Squashed 2 commits into one.', 'the selected run folds into one commit');
  assert.deepEqual((await git(['log', '--format=%s', '-2'])).split('\n'),
    ['add sq3', 'sq1 and sq2, squashed'], 'the run became one commit and sq3 was replayed untouched');
  assert.deepEqual((await git(['show', '--stat', '--format=', 'HEAD~1'])).match(/sq\d\.txt/g).sort(),
    ['sq1.txt', 'sq2.txt'], 'both changes are inside the single squashed commit');

  // --- rejected IPC input ---------------------------------------------------
  const rejected = await page.evaluate(async () => {
    const workspace = await window.twig.getWorkspace();
    const id = workspace.activeId;
    const results = await Promise.allSettled([
      window.twig.resetTo(id, 'keep', '0'.repeat(40)),
      window.twig.createBranch(id, 'bad name', '0'.repeat(40), false),
      window.twig.runSequencer(id, 'push', 'continue'),
      window.twig.readConflict(id, '../escape'),
      window.twig.rebaseOnto(id, 'not-an-oid', null),
      window.twig.rewordCommit(id, 'not-an-oid', 'a message'),
      window.twig.rewordCommit(id, '0'.repeat(40), ''),
      window.twig.rebaseOnto(id, '0'.repeat(40), [{ action: 'fixup', oid: '0'.repeat(40) }])
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(8).fill('rejected'));

  // The commit panel finishes loading before the theme shots, so the review
  // images show the real thing rather than skeleton placeholders. The author,
  // message and metadata start collapsed, so reveal them for the review images.
  await page.getByRole('button', { name: 'Show details' }).click();
  await page.getByRole('complementary', { name: 'Commit details' }).getByText('Twig Fixture').first().waitFor();
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await shot(theme);
    // The new surfaces need reviewing in both themes, not only in dark.
    await page.getByRole('option', { name: /add beta/ }).click({ button: 'right' });
    await menu.waitFor();
    await shot(`menu-${theme}`);
    // The reword dialog is a new surface, so it is reviewed in both themes
    // too. Cancelling it leaves the repository exactly as it was.
    await menu.getByRole('menuitem', { name: /^Reword / }).click();
    const themed = page.getByRole('dialog');
    await themed.waitFor();
    await shot(`reword-${theme}`);
    await themed.getByRole('button', { name: 'Cancel', exact: true }).click();
    await themed.waitFor({ state: 'detached' });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('M4 Electron passed: context menu, merge conflict, conflict editor, banner, confirmation, interactive rebase, reword on the tip and inside history, multi-select squash, IPC validation.');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
