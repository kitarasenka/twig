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
// `safe.bareRepository` counts only from the command line or the person's own
// config: a folder a project keeps in its tree that looks like a Git directory
// (HEAD, refs/, objects/, config) is not a repository of its own here, and its
// config is never read. A real bare repository needs an explicit `--git-dir`.
// `ext::` and `fd::` make a remote address a command, and `url.*.insteadOf` can
// turn any address into one, so they are off whatever the repository's config
// says. GIT_ALLOW_PROTOCOL would close them too, but it has to list `file`,
// which allows it for submodules as well, and it stops every remote helper.
export const BASE_ARGS = ['--no-pager', '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'core.fsmonitor=false',
  '-c', 'safe.bareRepository=explicit', '-c', 'protocol.ext.allow=never', '-c', 'protocol.fd.allow=never'];

/** Text a read may hold when the caller named no limit: above any list or log worth parsing, far below V8's string limit. */
export const MAX_TEXT_OUTPUT = 128 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;

let gate = null;
/**
 * What `main/repository-trust.js` decides before each Git process: a `cwd` in a
 * repository whose settings changed since the person accepted them is refused
 * until they answer, and only a partial clone they accepted may fetch missing
 * objects on a read. Nothing is set in the Node checks.
 * @param {?(cwd: string, options: { explicit: boolean }) => Promise<?{ refused?: string, lazyFetch?: boolean }>} check
 */
export function setGitGate(check) { gate = check; }

const askGate = (cwd, argv) => gate(cwd, { explicit: argv[0].startsWith('--git-dir=') }).catch(error => ({ refused: error.message }));

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
 *
 * No lazy fetch: in a partial clone a read of a missing object runs `git fetch`
 * by itself, with the program `remote.<name>.uploadpack` names, so `git status`
 * in a folder from an archive would run it. A partial clone the person accepted
 * gets its objects as usual (`lazyFetch`).
 */
function gitEnvironment(env, lazyFetch = false) {
  const environment = {
    ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: `"${process.execPath}" "${askpass}"`, GIT_NO_LAZY_FETCH: '1'
  };
  if (lazyFetch) delete environment.GIT_NO_LAZY_FETCH;
  return environment;
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
 * `maxBytes` stops a read once it outgrows what the caller can use: the process
 * is killed and the result says `truncated`, with the output up to the limit —
 * a caller that names a limit knows what part of the output is worth. A read
 * that names none gets MAX_TEXT_OUTPUT, and running over it is a failure (`code`
 * -1, `truncated`, the reason in stderr): most of what comes back here is parsed
 * as a whole, and half of a NUL-separated list must not pass for all of it.
 * `ungated` is for the check of a repository's settings itself.
 * @param {{ argv: string[], cwd: string, log: import('../command-log.js').CommandLog,
 *   operation?: string, stdin?: ?string, signal?: ?AbortSignal, env?: ?Record<string, string>,
 *   binary?: boolean, maxBytes?: ?number, ungated?: boolean }} options
 */
export async function runGit({ argv, cwd, log, operation = 'Git command', stdin = null, signal = null, env = null, binary = false, maxBytes = null, ungated = false }) {
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
  const verdict = gate && !ungated ? await askGate(cwd, argv) : null;
  if (verdict?.refused) {
    const reason = `${verdict.refused}\n`;
    const refusal = { argv: command, cwd, code: -1, stdout: '', stderr: reason, cancelled: false, ms: Math.round(performance.now() - started), startedAt, refused: true };
    await log.output(id, 'stderr', reason);
    await log.finish(id, refusal);
    return binary ? { ...refusal, stdout: Buffer.alloc(0), truncated: false } : refusal;
  }
  const limit = maxBytes ?? (binary ? Infinity : MAX_TEXT_OUTPUT);
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
        const summary = `${bytes} bytes of binary output, not shown${truncated ? ` (stopped at ${limit} bytes)` : ''}.\n`;
        await log.output(id, 'stdout', summary);
        await log.finish(id, { ...result, stdout: summary });
        resolve({ ...result, stdout: Buffer.concat(chunks), truncated });
        return;
      }
      await log.finish(id, result);
      resolve(truncated ? { ...result, truncated } : result);
    };
    const addError = (text) => {
      if (stderr.length >= MAX_STDERR) return;
      stderr += text;
      void log.output(id, 'stderr', text);
    };
    let child;
    try {
      child = spawn('git', command, { cwd, shell: false, windowsHide: true, env: gitEnvironment(env, verdict?.lazyFetch) });
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
      if (bytes > limit) { truncated = true; child.kill(); return; }
      chunks.push(chunk);
    });
    else child.stdout.on('data', (chunk) => {
      if (truncated) return;
      const text = chunk.toString('utf8');
      if (stdout.length + text.length > limit) {
        truncated = true;
        if (maxBytes !== null) stdout += text.slice(0, limit - stdout.length);
        else addError(`Stopped by 🌱 Twig: Git wrote more than ${Math.round(limit / 1024 / 1024)} MB.\n`);
        child.kill();
        return;
      }
      stdout += text;
      void log.output(id, 'stdout', text);
    });
    child.stderr.on('data', (chunk) => addError(chunk.toString('utf8')));
    child.once('error', (error) => {
      addError(error.message);
      void finish(-1);
    });
    child.once('close', (code) => { void finish(truncated ? -1 : code ?? -1); });
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
  let child = null;
  let paused = false;
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
  const addError = text => {
    if (stderr.length >= MAX_STDERR) return;
    stderr += text;
    void log.output(id, 'stderr', text);
  };
  const launch = verdict => {
    if (stopped !== null) { finish(-1); return; }
    if (verdict?.refused) { addError(`${verdict.refused}\n`); finish(-1); return; }
    try {
      child = spawn('git', command, { cwd, shell: false, windowsHide: true, env: gitEnvironment(null, verdict?.lazyFetch) });
    } catch (error) {
      addError(error.message);
      queueMicrotask(() => finish(-1));
      return;
    }
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', text => { void log.output(id, 'stdout', text); onData(text); });
    child.stderr.on('data', addError);
    child.once('error', error => { addError(error.message); finish(-1); });
    child.once('close', code => finish(code ?? -1));
    if (paused) child.stdout.pause();
  };
  if (gate) void askGate(cwd, argv).then(launch);
  else launch(null);
  return {
    pause: () => { paused = true; if (!settled) child?.stdout.pause(); },
    resume: () => { paused = false; if (!settled) child?.stdout.resume(); },
    stop(note = 'Stopped by 🌱 Twig.\n') {
      if (settled || stopped !== null) return;
      stopped = note;
      stderr += note;
      void log.output(id, 'stderr', note);
      child?.kill();
    }
  };
}
