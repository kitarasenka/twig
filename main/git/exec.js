import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const askpass = fileURLToPath(new URL('./askpass.cjs', import.meta.url));
// `log.showSignature` set by the person would make every `log` and `show` print
// the signature program's output into stdout, in the middle of the NUL-separated
// records the parsers read. An explicit `--show-signature` typed in the console
// still wins over it.
// `core.fsmonitor` names a program `git status` runs on every read — and 🌱 Twig
// reads on its own (on open, on every refresh). A repository's config must not
// turn that into running someone's command, so Git's own scan is used instead.
export const BASE_ARGS = ['--no-pager', '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'core.fsmonitor=false'];

function validArguments(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.every(argument => typeof argument === 'string');
}

/**
 * The environment every Git process gets. `env` adds variables for one run;
 * the fixed safety variables after it cannot be overridden.
 *
 * No optional locks: `git status` (which 🌱 Twig runs on every refresh, focus
 * and action) otherwise takes `index.lock` to rewrite the index whenever files
 * were touched, and a `git add` or `git commit` the person runs in a terminal
 * at that moment fails with "index.lock: File exists". Commands that change
 * the index still take the lock they need.
 */
function gitEnvironment(env) {
  return {
    ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: `"${process.execPath}" "${askpass}"`
  };
}

/**
 * Run a system Git command and mirror every lifecycle event into the command log.
 *
 * `stdin` feeds a patch to `git apply` without ever writing it to disk. Its
 * content is deliberately kept out of the journal — it is the user's own
 * source, and the journal is persisted — so the console records only how many
 * bytes were piped in, which keeps the log honest without leaking the file.
 * `signal` makes long network operations cancellable, as required for pull
 * and push: aborting kills the process and the cancellation is recorded.
 * `env` adds variables for a single run — rebase needs GIT_SEQUENCE_EDITOR
 * and GIT_EDITOR pointed at this app, and leaving those set for every command
 * would change how unrelated commands behave. It cannot override the fixed
 * safety variables below, and the caller must say in `operation` that it
 * installed an editor, because the console shows argv and not the environment.
 * `binary` returns stdout as a Buffer (image bytes would not survive UTF-8),
 * and the journal records only how many bytes came back, never the bytes.
 * `maxBytes` stops such a read once it outgrows what the caller can use: the
 * process is killed and the result says `truncated`.
 * @param {{ argv: string[], cwd: string, log: import('../command-log.js').CommandLog,
 *   operation?: string, stdin?: ?string, signal?: ?AbortSignal, env?: ?Record<string, string>,
 *   binary?: boolean, maxBytes?: number }} options
 */
export async function runGit({ argv, cwd, log, operation = 'Git command', stdin = null, signal = null, env = null, binary = false, maxBytes = Infinity }) {
  if (!validArguments(argv) || typeof cwd !== 'string' || !cwd) throw new TypeError('Invalid Git command');
  if (stdin !== null && typeof stdin !== 'string') throw new TypeError('Invalid Git command');
  if (env !== null && (typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string'))) {
    throw new TypeError('Invalid Git command');
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const id = randomUUID();
  const command = [...BASE_ARGS, ...argv];
  const label = stdin === null ? operation : `${operation} · ${Buffer.byteLength(stdin, 'utf8')} bytes on stdin`;
  // The entry exists in memory as soon as this returns; Git does not wait for
  // the journal's file write to start.
  void log.start({ id, argv: command, cwd, operation: label, startedAt });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let abort = null;
    let cancelled = false;
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      if (signal && abort) signal.removeEventListener('abort', abort);
      const result = { argv: command, cwd, code, stdout, stderr, cancelled, ms: Math.round(performance.now() - started), startedAt };
      if (binary) {
        const summary = `${bytes} bytes of binary output, not shown${truncated ? ` (stopped at ${maxBytes} bytes)` : ''}.\n`;
        await log.output(id, 'stdout', summary);
        await log.finish(id, { ...result, stdout: summary });
        resolve({ ...result, stdout: Buffer.concat(chunks), truncated });
        return;
      }
      await log.finish(id, result);
      resolve(result);
    };
    let child;
    try {
      child = spawn('git', command, { cwd, shell: false, windowsHide: true, env: gitEnvironment(env) });
    } catch (error) {
      stderr = error.message;
      void log.output(id, 'stderr', stderr).finally(() => void finish(-1));
      return;
    }
    // Always close stdin: a Git command left waiting on an open pipe would
    // hang forever with no output to explain why.
    if (stdin === null) child.stdin.end();
    else {
      child.stdin.on('error', () => {});
      child.stdin.end(stdin, 'utf8');
    }
    if (signal) {
      abort = () => {
        cancelled = true;
        stderr += 'Cancelled in 🌱 Twig.\n';
        void log.output(id, 'stderr', 'Cancelled in 🌱 Twig.\n');
        child.kill();
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
    if (!binary) child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    if (binary) child.stdout.on('data', (chunk) => {
      if (truncated) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { truncated = true; child.kill(); return; }
      chunks.push(chunk);
    });
    else child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      void log.output(id, 'stdout', text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      void log.output(id, 'stderr', text);
    });
    child.once('error', (error) => {
      stderr += error.message;
      void log.output(id, 'stderr', error.message);
      void finish(-1);
    });
    child.once('close', (code) => { void finish(code ?? -1); });
  });
}

/**
 * A long Git read handed over as it arrives, for readers that consume it a
 * piece at a time: the history graph reads one `git log` as far as it has
 * scrolled. `pause` stops reading (the pipe fills and Git waits), `resume`
 * goes on, `stop` ends it — journaled as cancelled by 🌱 Twig with `note`, not
 * as a failure. Journaled like `runGit` otherwise: the same entry, its output
 * kept to the journal's cap.
 * @param {{ argv: string[], cwd: string, log: import('../command-log.js').CommandLog, operation?: string,
 *   onData: (text: string) => void, onEnd: (end: { code: number, stderr: string, cancelled: boolean }) => void }} options
 */
export function streamGit({ argv, cwd, log, operation = 'Git command', onData, onEnd }) {
  if (!validArguments(argv) || typeof cwd !== 'string' || !cwd || typeof onData !== 'function' || typeof onEnd !== 'function') {
    throw new TypeError('Invalid Git command');
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const id = randomUUID();
  const command = [...BASE_ARGS, ...argv];
  void log.start({ id, argv: command, cwd, operation, startedAt });
  let stderr = '';
  let stopped = null;
  let settled = false;
  const finish = code => {
    if (settled) return;
    settled = true;
    const cancelled = stopped !== null;
    const end = { code: cancelled ? -1 : code, stderr, cancelled };
    // No `stdout` here: the journal keeps what streamed, and holding the whole
    // history as one string is what reading it in pieces avoids.
    void log.finish(id, { argv: command, cwd, code: end.code, stderr, cancelled, ms: Math.round(performance.now() - started), startedAt });
    onEnd(end);
  };
  let child;
  try {
    child = spawn('git', command, { cwd, shell: false, windowsHide: true, env: gitEnvironment(null) });
  } catch (error) {
    stderr = error.message;
    void log.output(id, 'stderr', stderr);
    queueMicrotask(() => finish(-1));
    return { pause() {}, resume() {}, stop() {} };
  }
  child.stdin.end();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => { void log.output(id, 'stdout', text); onData(text); });
  child.stderr.on('data', text => { stderr += text; void log.output(id, 'stderr', text); });
  child.once('error', error => { stderr += error.message; void log.output(id, 'stderr', error.message); finish(-1); });
  child.once('close', code => finish(code ?? -1));
  return {
    pause: () => { if (!settled) child.stdout.pause(); },
    resume: () => { if (!settled) child.stdout.resume(); },
    stop(note = 'Stopped by 🌱 Twig.\n') {
      if (settled || stopped !== null) return;
      stopped = note;
      stderr += note;
      void log.output(id, 'stderr', note);
      child.kill();
    }
  };
}
