import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { classifyPrompt, createAskpassBroker, createPromptQueue, validAnswer } from '../../main/askpass.js';
import { runGit, setAskpassBroker } from '../../main/git/exec.js';
import { createSshService, knownHostsName, parseKeyscan, sshHostPlan } from '../../main/ssh/service.js';
import { runSsh } from '../../main/ssh/exec.js';

const HOST_PROMPT = "The authenticity of host 'github.com (140.82.121.4)' can't be established.\nED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ";

// What kind of question each prompt is.
assert.deepEqual(classifyPrompt(HOST_PROMPT), { kind: 'host', host: 'github.com (140.82.121.4)', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU' });
assert.equal(classifyPrompt("Password for 'https://alice@github.com': ").kind, 'secret');
assert.equal(classifyPrompt("Enter passphrase for key '/Users/a/.ssh/id_twig': ").kind, 'secret');
assert.equal(classifyPrompt("Username for 'https://github.com': ").kind, 'text');
assert.equal(classifyPrompt('Confirm user presence for key ED25519', 'none').kind, 'notice');
assert.equal(classifyPrompt('Allow use of key?', 'confirm').kind, 'confirm');
assert.equal(validAnswer('token'), true);
assert.equal(validAnswer('two\nlines'), false);
assert.equal(validAnswer('x'.repeat(5000)), false);
assert.equal(validAnswer(null), false);

// One question at a time, in order; a stale id or a bad answer does not count.
{
  const shown = [];
  const queue = createPromptQueue({ present: view => shown.push(view), timeoutMs: 50 });
  const first = queue.ask({ prompt: "Username for 'https://a': ", operation: 'Push', folder: 'repo' });
  const second = queue.ask({ prompt: "Password for 'https://a': " });
  assert.equal(shown.at(-1).prompt, "Username for 'https://a': ");
  assert.equal(shown.at(-1).waiting, 2);
  const firstId = shown.at(-1).id;
  const secondId = queue.current().id === firstId ? null : queue.current().id;
  assert.equal(secondId, null, 'only the first question is on screen');
  assert.equal(queue.answer('ask-999', 'x'), false);
  assert.equal(queue.answer(firstId, 'bad\nanswer'), false);
  assert.equal(queue.answer(firstId, 'alice'), true);
  assert.equal(await first, 'alice');
  assert.equal(shown.at(-1).kind, 'secret');
  assert.equal(await second, null, 'a question nobody answers ends after the timeout');
  assert.equal(shown.at(-1), null, 'the dialog goes away when nothing is left');
  const controller = new AbortController();
  const third = queue.ask({ prompt: 'Username: ', signal: controller.signal });
  controller.abort();
  assert.equal(await third, null);
  assert.equal(queue.current(), null);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-askpass-check-'));
const asked = [];
let reply = () => null;
const broker = await createAskpassBroker({ ask: request => { asked.push(request); return reply(request); }, tmpdir: root });
try {
  const log = new CommandLog(root); await log.load();
  const cwd = path.join(root, 'work');
  await runGit({ argv: ['init', '-q', cwd], cwd: root, log });
  if (process.platform !== 'win32') {
    const folder = path.dirname(broker.socket);
    assert.equal((await stat(folder)).mode & 0o777, 0o700, 'the socket folder is private');
    assert.equal((await stat(broker.socket)).mode & 0o777, 0o600);
  }
  setAskpassBroker(broker);
  const credential = { argv: ['-c', 'credential.helper=', 'credential', 'fill'], cwd, log, stdin: 'protocol=https\nhost=example.com\n\n', operation: 'Fill a credential' };

  // An action the person started asks in the window, and Git gets the answer.
  reply = request => (request.prompt.startsWith('Username') ? 'alice' : 'fixture-token');
  const filled = await runGit({ ...credential, prompt: true });
  assert.equal(filled.code, 0, filled.stderr);
  assert.match(filled.stdout, /^username=alice$/m);
  assert.match(filled.stdout, /^password=fixture-token$/m);
  assert.deepEqual(asked.map(request => request.prompt), ["Username for 'https://example.com': ", "Password for 'https://alice@example.com': "]);
  assert.equal(asked[0].operation, 'Fill a credential');
  assert.equal(asked[0].folder, 'work');
  assert.equal(broker.sessions(), 0, 'the token ends with the process');

  // Without `prompt` nothing asks: background fetch and the agent's reads stay silent.
  asked.length = 0;
  const silent = await runGit(credential);
  assert.equal(asked.length, 0);
  assert.doesNotMatch(silent.stdout, /alice|fixture-token/);

  // Cancel in the window stops Git.
  reply = () => null;
  const cancelled = await runGit({ ...credential, prompt: true });
  assert.notEqual(cancelled.code, 0);
  assert.equal(asked.length, 1, 'Git stops at the first unanswered question');

  // Cancelling the action takes the question away and Git does not hang on it.
  asked.length = 0;
  let aborted = false;
  reply = request => new Promise(resolve => request.signal.addEventListener('abort', () => { aborted = true; resolve(null); }));
  const controller = new AbortController();
  const started = Date.now();
  const pending = runGit({ ...credential, prompt: true, signal: controller.signal });
  while (!asked.length) await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.cancelled, true);
  assert.equal(aborted, true, 'the question left the screen');
  assert.ok(Date.now() - started < 10000);
  assert.equal(broker.sessions(), 0);

  // A token the broker did not hand out gets nothing.
  const script = path.join(path.dirname(broker.socket), 'askpass.cjs');
  const run = (file, args, env) => new Promise(resolve => {
    const child = spawn(file, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }, shell: false });
    let out = ''; child.stdout.on('data', chunk => { out += chunk; });
    child.on('close', code => resolve({ code, out }));
  });
  asked.length = 0;
  const forged = await run(process.execPath, [script, 'Password: '], { TWIG_ASKPASS_SOCKET: broker.socket, TWIG_ASKPASS_TOKEN: 'f'.repeat(64) });
  assert.equal(forged.code, 1);
  assert.equal(asked.length, 0);
  // No socket at all: the old empty answer.
  const bare = await run(process.execPath, [script, 'Password: '], {});
  assert.deepEqual(bare, { code: 0, out: '' });

  // ssh runs SSH_ASKPASS as a program: the wrapper reaches the window, and an
  // unknown host key is answered with `yes` only when the person trusts it.
  if (process.platform !== 'win32') {
    const session = broker.open({ operation: 'Push', cwd });
    reply = request => (classifyPrompt(request.prompt, request.mode).kind === 'host' ? 'yes' : null);
    const trusted = await run(session.env.SSH_ASKPASS, [HOST_PROMPT], session.env);
    assert.deepEqual(trusted, { code: 0, out: 'yes\n' });
    assert.equal(session.env.GIT_ASKPASS, session.env.SSH_ASKPASS);
    assert.equal(session.env.SSH_ASKPASS_REQUIRE, 'force');
    session.close();
    const closed = await run(session.env.SSH_ASKPASS, [HOST_PROMPT], session.env);
    assert.equal(closed.code, 1, 'a closed session answers nothing');
  }
  assert.equal(JSON.stringify(log.list()).includes('TWIG_ASKPASS_TOKEN'), false);

  // ~/.ssh/config: a Host block for a key ssh does not try by itself.
  const identity = '~/.ssh/id_twig';
  const empty = sshHostPlan('', 'github.com', identity);
  assert.equal(empty.content, 'Host github.com\n  IdentityFile ~/.ssh/id_twig\n  IdentitiesOnly yes\n  AddKeysToAgent yes\n');
  assert.match(sshHostPlan('', 'github.com', identity, { keychain: true }).content, /AddKeysToAgent yes\n {2}UseKeychain yes\n$/);
  const global = 'ServerAliveInterval 30\n\nHost *\n  User nobody\n';
  const placed = sshHostPlan(global, 'gitlab.com', identity).content;
  assert.ok(placed.indexOf('Host gitlab.com') > placed.indexOf('ServerAliveInterval'), 'global lines stay global');
  assert.ok(placed.indexOf('Host gitlab.com') < placed.indexOf('Host *'), 'the block comes before a catch-all');
  assert.equal(sshHostPlan(empty.content, 'github.com', identity).already, true);
  assert.equal(sshHostPlan('Host "github.com" other\n  IdentityFile "~/.ssh/id_twig"\n', 'GitHub.com', identity).already, true);
  assert.equal(sshHostPlan('Host github.com\n  IdentityFile ~/.ssh/other\n', 'github.com', identity).already, false);
  assert.match(sshHostPlan('Host a\r\n  User git\r\n', 'b.example', identity).content, /Host b\.example\r\n {2}IdentityFile/);
  assert.throws(() => sshHostPlan('', '*.example.com', identity), TypeError);
  assert.throws(() => sshHostPlan('', 'host name', identity), TypeError);
  assert.equal(knownHostsName('example.com', 22), 'example.com');
  assert.equal(knownHostsName('example.com', 2222), '[example.com]:2222');

  // Settings: a real key, a real config check by ssh, a host scan through a
  // stand-in ssh-keyscan on PATH (no network here), known_hosts written once.
  const home = path.join(root, 'home');
  const ssh = createSshService({ home, log });
  const keys = await ssh.generate({ name: 'id_twig', comment: 'Twig Fixture', passphrase: 'fixture-passphrase' });
  let config = await ssh.readConfig();
  const added = await ssh.addHost('id_twig.pub', 'github.com', config.digest);
  assert.equal(added.already, false);
  assert.match(await readFile(path.join(home, '.ssh', 'config'), 'utf8'), /^Host github\.com\n {2}IdentityFile ~\/\.ssh\/id_twig\n/);
  const again = await ssh.addHost('id_twig.pub', 'github.com', added.digest);
  assert.equal(again.already, true);
  await assert.rejects(ssh.addHost('id_twig.pub', 'github.com', config.digest), /changed outside/);
  await assert.rejects(ssh.addHost('../x.pub', 'github.com', again.digest), TypeError);
  await assert.rejects(ssh.addHost('id_twig.pub', '-oProxyCommand=x', again.digest), TypeError);
  assert.ok(log.list().some(entry => entry.executable === '🌱 Twig' && entry.argv.join(' ').startsWith('add Host github.com')));

  // Real OpenSSH through the same program: ssh-add asks for the key's
  // passphrase with SSH_ASKPASS, and the key reaches a throwaway agent.
  if (process.platform !== 'win32') {
    const agentSocket = path.join(root, 'agent.sock');
    const agent = spawn('ssh-agent', ['-D', '-a', agentSocket], { stdio: 'ignore', shell: false });
    try {
      for (let wait = 0; wait < 50; wait++) { if (await stat(agentSocket).catch(() => null)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
      const session = broker.open({ operation: 'Push', cwd });
      asked.length = 0;
      reply = request => (classifyPrompt(request.prompt).kind === 'secret' ? 'fixture-passphrase' : null);
      const env = { ...session.env, SSH_AUTH_SOCK: agentSocket };
      const added = await new Promise(resolve => {
        const child = spawn('ssh-add', [path.join(home, '.ssh', 'id_twig')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true });
        let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { out += chunk; });
        child.on('close', code => resolve({ code, out }));
      });
      session.close();
      assert.equal(added.code, 0, added.out);
      assert.match(asked[0].prompt, /passphrase/i);
      const listed = await runSsh({ executable: 'ssh-keygen', argv: ['-lf', path.join(home, '.ssh', 'id_twig.pub')], cwd: root, log });
      const inAgent = await new Promise(resolve => {
        const child = spawn('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: agentSocket }, shell: false });
        let out = ''; child.stdout.on('data', chunk => { out += chunk; }); child.on('close', () => resolve(out));
      });
      assert.ok(inAgent.includes(listed.stdout.split(' ')[1]), 'the key is in the agent');
    } finally { agent.kill(); }
  }

  if (process.platform !== 'win32') {
    const bin = path.join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const offered = keys[0].publicKey.split(' ').slice(0, 2).join(' ');
    const fake = path.join(bin, 'ssh-keyscan');
    const writeScan = line => writeFile(fake, `#!/bin/sh\necho "# example.test:22 SSH-2.0-Fixture"\necho "example.test ${line}"\n`, { mode: 0o755 });
    await writeScan(offered);
    await chmod(fake, 0o755);
    const pathBefore = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${pathBefore}`;
    try {
      assert.equal(parseKeyscan(`# c\nexample.test ${offered}\nnot a key line\n`).length, 1);
      const first = await ssh.scanHost('git@example.test');
      assert.equal(first.state, 'unknown');
      assert.equal(first.host, 'example.test');
      assert.equal(first.keys[0].fingerprint, keys[0].fingerprint);
      assert.equal(typeof first.token, 'string');
      const trusted = await ssh.trustHost(first.token);
      assert.equal(trusted.added, 1);
      const knownFile = path.join(home, '.ssh', 'known_hosts');
      assert.equal(await readFile(knownFile, 'utf8'), `example.test ${offered}\n`);
      assert.equal((await stat(knownFile)).mode & 0o777, 0o600);
      await assert.rejects(ssh.trustHost(first.token), TypeError, 'a token is spent on use');
      const second = await ssh.scanHost('example.test');
      assert.equal(second.state, 'known');
      assert.equal(second.token, undefined);
      // A host that now offers another key is not trusted over the old one.
      const other = (await ssh.generate({ name: 'id_other', comment: '', passphrase: 'fixture-passphrase' })).find(key => key.name === 'id_other.pub');
      await writeScan(other.publicKey.split(' ').slice(0, 2).join(' '));
      const changed = await ssh.scanHost('example.test');
      assert.equal(changed.state, 'changed');
      assert.equal(changed.token, undefined);
      assert.equal(await readFile(knownFile, 'utf8'), `example.test ${offered}\n`);
      // The alias resolves through the config, as ssh would.
      config = await ssh.readConfig();
      await ssh.saveConfig(`Host twig-alias\n  HostName example.test\n  Port 2222\n${config.content}`, config.digest);
      const alias = await ssh.scanHost('twig-alias');
      assert.equal(alias.host, 'example.test');
      assert.equal(alias.port, 2222);
      assert.equal(alias.state, 'unknown');
      await ssh.trustHost(alias.token);
      assert.match(await readFile(knownFile, 'utf8'), /^\[example\.test\]:2222 ssh-ed25519 /m);
      await rm(knownFile); await writeFile(path.join(root, 'outside'), 'unchanged');
      await symlink(path.join(root, 'outside'), knownFile);
      await writeScan(offered);
      await assert.rejects((async () => ssh.trustHost((await ssh.scanHost('example.test')).token))(), /regular/);
      assert.equal(await readFile(path.join(root, 'outside'), 'utf8'), 'unchanged');
    } finally { process.env.PATH = pathBefore; }
  }
  assert.equal(JSON.stringify(log.list()).includes('fixture-passphrase'), false);
  await assert.rejects(runSsh({ executable: 'sh', argv: [], cwd: root, log }), TypeError);
  console.log('Askpass checks passed: prompt kinds, one question at a time, Git gets the answer only for actions that ask, Cancel and cancellation, forged tokens, the ssh wrapper, ssh-add through it, Host blocks, host-key scan, trust once, changed keys refused.');
} finally {
  setAskpassBroker(null);
  await broker.stop();
  await rm(root, { recursive: true, force: true });
}
