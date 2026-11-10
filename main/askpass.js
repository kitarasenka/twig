import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Asking the person what Git or ssh wants to know — a username, a password or
 * token, a key's passphrase, whether to trust a host key — in 🌱 Twig's window,
 * for the actions they started (push, pull, fetch, clone, …). There is no
 * terminal to type it into, and the askpass program Git ran before answered
 * nothing, so a push over HTTPS without a stored credential, or with an
 * encrypted key, simply failed.
 *
 * `main/git/askpass.cjs` talks to a socket in a fresh 0700 folder under the
 * temp directory (a named pipe on Windows). Each action gets its own random
 * token, in the environment of that one Git process only (`open`); an answer
 * goes back to whoever holds it, and `close` (the process ended or was
 * cancelled) drops the token, ends its connections and takes its question off
 * the screen. Nothing here is written to disk or to the journal: the prompt is
 * Git's text, the answer is the person's.
 */

const SCRIPT = fileURLToPath(new URL('./git/askpass.cjs', import.meta.url));
const MAX_REQUEST = 16 * 1024;
export const ASK_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_ANSWER = 4096;

/**
 * What kind of question a prompt is. OpenSSH asks about an unknown host key
 * with "Are you sure you want to continue connecting (yes/no/[fingerprint])?",
 * and its fingerprint and host are in the lines above. A notice (`SSH_ASKPASS_PROMPT=none`,
 * "Confirm user presence for key …") wants no answer; `confirm` wants yes or no.
 * @param {string} prompt
 * @param {string} [mode] SSH_ASKPASS_PROMPT
 * @returns {{ kind: 'host'|'secret'|'text'|'confirm'|'notice', host: ?string, fingerprint: ?string }}
 */
export function classifyPrompt(prompt, mode = '') {
  const text = String(prompt ?? '');
  const none = { host: null, fingerprint: null };
  if (mode === 'none') return { kind: 'notice', ...none };
  if (/continue connecting \(yes\/no(\/\[fingerprint\])?\)\?/i.test(text)) {
    const host = text.match(/authenticity of host '([^']{1,300})'/i)?.[1] ?? null;
    const fingerprint = text.match(/\b(SHA256:[A-Za-z0-9+/=]{20,})/)?.[1] ?? text.match(/\b(MD5(?::[0-9a-f]{2}){16})/i)?.[1] ?? null;
    return { kind: 'host', host, fingerprint };
  }
  if (mode === 'confirm') return { kind: 'confirm', ...none };
  if (/pass(word|phrase)|token|\bPIN\b|secret/i.test(text)) return { kind: 'secret', ...none };
  return { kind: 'text', ...none };
}

/** An answer that can go to Git: one line, no NUL, not too long. */
export function validAnswer(value) {
  return typeof value === 'string' && value.length <= MAX_ANSWER && !/[\0\r\n]/.test(value);
}

const posixQuote = value => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * One question on screen at a time; the rest wait in order. `present(view)`
 * shows a question (null: nothing to ask), `answer(id, value)` is the person's
 * reply (null: Cancel). A question whose Git process ended, or that waited
 * past `timeoutMs`, leaves the queue and is answered with null.
 * @param {{ present: (view: ?object) => void, timeoutMs?: number }} options
 */
export function createPromptQueue({ present, timeoutMs = ASK_TIMEOUT_MS }) {
  const waiting = [];
  let shown = null;
  let counter = 0;
  const view = item => ({ id: item.id, kind: item.kind, prompt: item.prompt, host: item.host, fingerprint: item.fingerprint,
    operation: item.operation, folder: item.folder, waiting: waiting.length });
  const show = () => {
    if (shown && waiting.includes(shown)) { present(view(shown)); return; }
    shown = waiting[0] ?? null;
    present(shown ? view(shown) : null);
  };
  const settle = (item, value) => {
    const at = waiting.indexOf(item);
    if (at < 0) return;
    waiting.splice(at, 1);
    clearTimeout(item.timer);
    item.signal?.removeEventListener('abort', item.onAbort);
    item.resolve(value);
    if (shown === item) shown = null;
    show();
  };
  return {
    /** @returns {Promise<?string>} */
    ask({ prompt, mode = '', operation = '', folder = '', signal = null }) {
      return new Promise(resolve => {
        const item = { id: `ask-${++counter}`, prompt: String(prompt).slice(0, 4096), operation, folder, resolve, ...classifyPrompt(prompt, mode) };
        if (signal?.aborted) { resolve(null); return; }
        item.signal = signal;
        item.onAbort = () => settle(item, null);
        signal?.addEventListener('abort', item.onAbort, { once: true });
        item.timer = setTimeout(() => settle(item, null), timeoutMs);
        waiting.push(item);
        show();
      });
    },
    answer(id, value) {
      const item = waiting.find(entry => entry.id === id);
      if (!item || item !== shown) return false;
      if (value !== null && !validAnswer(value)) return false;
      settle(item, value);
      return true;
    },
    current: () => (shown ? view(shown) : null),
    cancelAll() { for (const item of [...waiting]) settle(item, null); }
  };
}

/**
 * The listening side. `ask(request)` resolves with the answer or null.
 * @param {{ ask: (request: { prompt: string, mode: string, operation: string, folder: string, signal: AbortSignal }) => Promise<?string>,
 *   platform?: string, execPath?: string, tmpdir?: string }} options
 */
export async function createAskpassBroker({ ask, platform = process.platform, execPath = process.execPath, tmpdir = os.tmpdir() }) {
  // mkdtemp makes the folder 0700 and new: no one else can have placed a socket in it.
  const dir = await mkdtemp(path.join(tmpdir, 'twig-askpass-'));
  await chmod(dir, 0o700);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('The askpass folder is not private.');
  }
  // The script sits next to the socket: inside a packaged app it lives in the
  // asar archive, which a program started by ssh cannot be pointed at.
  const script = path.join(dir, 'askpass.cjs');
  await writeFile(script, await readFile(SCRIPT), { mode: 0o700 });
  // Git (GIT_ASKPASS) and ssh (SSH_ASKPASS) both run the program they are
  // given as one file, with the prompt as its argument and no shell: a command
  // line with the executable and the script in it is not found and the prompt
  // falls through to a terminal there is none of. This wrapper is that file;
  // the paths in it are 🌱 Twig's own, quoted. Git for Windows runs it with its
  // own sh.
  const program = path.join(dir, 'askpass');
  await writeFile(program, `#!/bin/sh\nexec ${posixQuote(execPath)} ${posixQuote(script)} "$@"\n`, { mode: 0o700 });
  const socket = platform === 'win32' ? `\\\\.\\pipe\\twig-askpass-${randomBytes(12).toString('hex')}` : path.join(dir, 's');
  const sessions = new Map();

  const serve = connection => {
    let buffer = '';
    let handled = false;
    connection.setEncoding('utf8');
    connection.on('error', () => {});
    connection.on('data', chunk => {
      if (handled) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST) { connection.destroy(); return; }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      let request = null;
      try { request = JSON.parse(buffer.slice(0, end)); } catch { request = null; }
      const session = typeof request?.token === 'string' ? sessions.get(request.token) : null;
      if (!session || typeof request.prompt !== 'string') { connection.end(`${JSON.stringify({ cancel: true })}\n`); return; }
      const controller = new AbortController();
      session.pending.add(controller);
      // ssh kills the program of a notice when it is done; the question leaves with it.
      connection.on('close', () => controller.abort());
      void Promise.resolve(ask({ prompt: request.prompt, mode: typeof request.mode === 'string' ? request.mode : '',
        operation: session.operation, folder: session.folder, signal: controller.signal }))
        .catch(() => null)
        .then(answer => {
          session.pending.delete(controller);
          if (connection.destroyed) return;
          connection.end(`${JSON.stringify(validAnswer(answer) ? { answer } : { cancel: true })}\n`);
        });
    });
  };

  const server = net.createServer(serve);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => { server.off('error', reject); resolve(); });
  });
  if (platform !== 'win32') await chmod(socket, 0o600);

  return {
    socket,
    /**
     * The environment one Git process gets to ask through the window, and the
     * way to close it. ssh asks through SSH_ASKPASS even with a terminal
     * (`force`); OpenSSH before 8.4 also wants DISPLAY, which is left alone.
     * @param {{ operation?: string, cwd?: string }} options
     */
    open({ operation = '', cwd = '' } = {}) {
      const token = randomBytes(32).toString('hex');
      const session = { operation, folder: cwd ? path.basename(cwd) : '', pending: new Set() };
      sessions.set(token, session);
      const env = { TWIG_ASKPASS_SOCKET: socket, TWIG_ASKPASS_TOKEN: token, GIT_ASKPASS: program, SSH_ASKPASS: program, SSH_ASKPASS_REQUIRE: 'force' };
      let closed = false;
      return {
        env,
        close() {
          if (closed) return;
          closed = true;
          sessions.delete(token);
          for (const controller of session.pending) controller.abort();
          session.pending.clear();
        }
      };
    },
    sessions: () => sessions.size,
    async stop() {
      for (const session of sessions.values()) for (const controller of session.pending) controller.abort();
      sessions.clear();
      await new Promise(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };
}
