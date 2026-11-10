import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';
import { runSsh } from '../main/ssh/exec.js';

/**
 * Pull over HTTP from a remote that wants a username and a token: Git asks,
 * 🌱 Twig shows the question in its window, the answer reaches Git and the
 * branch moves. Cancel stops Git and the dialog goes away. A dumb-HTTP server
 * on 127.0.0.1 serves the bare repository behind Basic auth; nothing leaves
 * the machine and no credential helper or keychain is involved.
 */
const USER = 'alice';
const TOKEN = 'fixture-token-for-askpass';
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-askpass-ui-'));
let app; let server;
try {
  const home = path.join(root, 'home'); const bare = path.join(root, 'remote.git'); const cwd = path.join(root, 'repo');
  await mkdir(home);
  const log = new CommandLog(root); await log.load();
  const git = async (dir, ...argv) => { const result = await runGit({ cwd: dir, log, argv }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  await git(root, 'init', '--bare', '--initial-branch=main', bare);
  await git(root, 'clone', '--', bare, cwd);
  for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'twig@example.invalid'], ['commit.gpgsign', 'false']]) await git(cwd, 'config', key, value);
  await writeFile(path.join(cwd, 'file.txt'), 'one\n'); await git(cwd, 'add', '--', 'file.txt'); await git(cwd, 'commit', '-m', 'One');
  await writeFile(path.join(cwd, 'file.txt'), 'two\n'); await git(cwd, 'commit', '-am', 'Two');
  await git(cwd, 'push', 'origin', 'main');
  await git(root, `--git-dir=${bare}`, 'update-server-info');
  const tip = await git(cwd, 'rev-parse', 'HEAD');
  await git(cwd, 'reset', '--hard', 'HEAD~1');
  const behind = await git(cwd, 'rev-parse', 'HEAD');

  const expected = `Basic ${Buffer.from(`${USER}:${TOKEN}`).toString('base64')}`;
  let refused = 0;
  server = createServer(async (request, response) => {
    if (request.headers.authorization !== expected) {
      refused++;
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="twig"' }); response.end(); return;
    }
    const relative = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(/^\/remote\.git\//, '');
    const file = path.join(bare, relative);
    if (!file.startsWith(bare + path.sep)) { response.writeHead(404); response.end(); return; }
    try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(body); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/remote.git`;
  await git(cwd, 'remote', 'set-url', 'origin', url);

  const bootstrap = path.join(root, 'bootstrap.mjs');
  await writeFile(bootstrap, `import { app } from 'electron';\napp.setPath('home', ${JSON.stringify(home)});\napp.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});\nimport(${JSON.stringify(pathToFileURL(path.resolve('main/index.js')).href)});\n`);
  await writeFile(path.join(root, 'global'), '');
  // A stand-in ssh-keyscan on PATH: the host offers a key made here, so the
  // check runs without a network or an SSH server.
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const hostKey = path.join(root, 'host_key');
  assert.equal((await runSsh({ executable: 'ssh-keygen', argv: ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey], cwd: root, log })).code, 0);
  const offered = (await readFile(`${hostKey}.pub`, 'utf8')).trim().split(' ').slice(0, 2).join(' ');
  await writeFile(path.join(bin, 'ssh-keyscan'), `#!/bin/sh\necho "git.example.test ${offered}"\n`, { mode: 0o755 });
  const env = { ...process.env, TWIG_LANGUAGE: 'en', GIT_CONFIG_GLOBAL: path.join(root, 'global'), GIT_CONFIG_NOSYSTEM: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV; delete env.GIT_ASKPASS; delete env.SSH_ASKPASS;
  app = await electron.launch({ args: [bootstrap, `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => Boolean(window.twig));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  const pull = page.locator('.toolbar button.tool', { hasText: /^Pull/ }).first();

  // Cancel first: Git stops, the dialog goes, the branch stays where it was.
  await pull.click();
  let ask = page.getByRole('dialog', { name: 'Git needs an answer', exact: true });
  await ask.getByText(`Username for '${url.replace('/remote.git', '')}'`, { exact: false }).waitFor();
  await ask.getByText('Asked during Pull', { exact: false }).waitFor();
  await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
  await ask.waitFor({ state: 'detached' });
  await page.getByText(/Pull did not finish|could not|failed/i).first().waitFor();
  assert.equal(await git(cwd, 'rev-parse', 'HEAD'), behind);

  // Now answer: username, then the token in a password field.
  await pull.click();
  ask = page.getByRole('dialog', { name: 'Git needs an answer', exact: true });
  const field = ask.getByRole('textbox', { name: 'Answer', exact: true });
  await field.waitFor();
  assert.equal(await field.evaluate(element => element === document.activeElement), true, 'the field has the focus');
  await field.fill(USER);
  await ask.getByRole('button', { name: 'Send', exact: true }).click();
  const secret = page.getByRole('dialog', { name: 'Git needs a password', exact: true });
  await secret.getByText(`Password for '${url.replace('://', `://${USER}@`).replace('/remote.git', '')}'`, { exact: false }).waitFor();
  const password = secret.getByLabel('Password, token or passphrase', { exact: true });
  assert.equal(await password.getAttribute('type'), 'password');
  await secret.getByText('take a personal access token here', { exact: false }).waitFor();
  await mkdir('artifacts', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `artifacts/askpass-${theme}.png`, animations: 'disabled' });
  }
  await password.fill(TOKEN);
  await secret.getByRole('button', { name: 'Send', exact: true }).click();
  await secret.waitFor({ state: 'detached' });
  for (let wait = 0; wait < 100 && await git(cwd, 'rev-parse', 'HEAD') !== tip; wait++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await git(cwd, 'rev-parse', 'HEAD'), tip, 'the pull went through with the answers from the window');
  assert.ok(refused >= 2, 'the server did ask for credentials');

  // Nothing of the answer is kept: not in the journal, not in the repository's config.
  const journal = await page.evaluate(() => window.twig.getConsoleEntries());
  assert.equal(JSON.stringify(journal).includes(TOKEN), false);
  assert.equal((await readFile(path.join(cwd, '.git', 'config'), 'utf8')).includes(TOKEN), false);
  assert.equal(JSON.stringify(journal).includes('TWIG_ASKPASS_TOKEN'), false);

  // The renderer cannot answer what was not asked, or send a line break to Git.
  await assert.rejects(page.evaluate(() => window.twig.answerAskpass('ask-1', 'a\nb')), /Invalid askpass request/);
  await assert.rejects(page.evaluate(() => window.twig.answerAskpass(42, 'x')), /Invalid askpass request/);
  assert.equal(await page.evaluate(() => window.twig.answerAskpass('ask-999', 'x')), false);
  assert.equal(await page.evaluate(() => window.twig.getAskpassPrompt()), null);

  // Settings → SSH: a new key goes into ~/.ssh/config for its host, and an
  // unknown host key is trusted only after its fingerprint was on screen.
  assert.equal((await page.evaluate(() => window.twig.getSshConfig())).path, path.join(home, '.ssh', 'config'), 'never test SSH writes in the real user home');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'SSH keys and config', exact: true }).click();
  const ssh = page.getByRole('dialog', { name: 'SSH', exact: true });
  await ssh.getByRole('textbox', { name: 'Key filename', exact: true }).fill('id_twig_fixture');
  await ssh.getByLabel('Passphrase', { exact: true }).fill('fixture-secret-for-ui');
  await ssh.getByLabel('Repeat passphrase', { exact: true }).fill('fixture-secret-for-ui');
  await ssh.getByRole('button', { name: 'Generate key', exact: true }).click();
  const usage = ssh.getByRole('region', { name: 'Use a key with a Git host', exact: true });
  await usage.waitFor();
  assert.equal(await usage.locator('select').nth(0).inputValue(), 'id_twig_fixture.pub');
  await usage.locator('select').nth(1).selectOption('other');
  await usage.getByLabel('Host name', { exact: true }).fill('git.example.test');
  await usage.getByRole('button', { name: 'Add to SSH config', exact: true }).click();
  await ssh.getByText('Host git.example.test added to ~/.ssh/config.', { exact: true }).waitFor();
  assert.match(await readFile(path.join(home, '.ssh', 'config'), 'utf8'), /^Host git\.example\.test\n {2}IdentityFile ~\/\.ssh\/id_twig_fixture\n {2}IdentitiesOnly yes\n/);
  await usage.getByText('ssh-add', { exact: false }).first().waitFor();
  await usage.getByRole('button', { name: 'Add to SSH config', exact: true }).click();
  await ssh.getByText('~/.ssh/config already uses this key for git.example.test.', { exact: true }).waitFor();
  await ssh.getByRole('textbox', { name: 'SSH host', exact: true }).fill('git@git.example.test');
  await ssh.getByRole('button', { name: 'Check host key', exact: true }).click();
  const keys = ssh.getByRole('group', { name: 'Host keys of git.example.test', exact: true });
  const fingerprint = (await runSsh({ executable: 'ssh-keygen', argv: ['-lf', `${hostKey}.pub`], cwd: root, log })).stdout.split(' ')[1];
  await keys.getByText(fingerprint, { exact: true }).waitFor();
  await keys.getByRole('button', { name: 'Trust this host', exact: true }).click();
  await ssh.getByText('1 key of git.example.test added to ~/.ssh/known_hosts.', { exact: true }).waitFor();
  assert.equal(await readFile(path.join(home, '.ssh', 'known_hosts'), 'utf8'), `git.example.test ${offered}\n`);
  await keys.getByText('~/.ssh/known_hosts already has git.example.test', { exact: false }).waitFor();
  await assert.rejects(page.evaluate(() => window.twig.trustSshHost('not-a-token')), /Check the host again/);
  await assert.rejects(page.evaluate(() => window.twig.addSshHost('id_twig_fixture.pub', '*', 'x')), /Invalid|host name|changed/);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await usage.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/ssh-host-${theme}.png`, animations: 'disabled' });
  }
  assert.equal(JSON.stringify(await page.evaluate(() => window.twig.getConsoleEntries())).includes('fixture-secret-for-ui'), false);
  assert.deepEqual(errors, []);
  console.log('Askpass smoke passed: Cancel stops Pull, username and token asked in the window reach Git, password field, nothing kept, IPC refusals, Host block for a new key, host key checked and trusted once.');
} finally {
  await app?.close().catch(() => {});
  server?.close();
  await rm(root, { recursive: true, force: true });
}
