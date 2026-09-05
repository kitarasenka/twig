import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const askpass = fileURLToPath(new URL('./askpass.cjs', import.meta.url));
const baseArgs = ['--no-pager', '-c', 'color.ui=false'];

function validArguments(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.every(argument => typeof argument === 'string');
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
 * @param {{ argv: string[], cwd: string, log: import('../command-log.js').CommandLog,
 *   operation?: string, stdin?: ?string, signal?: ?AbortSignal, env?: ?Record<string, string> }} options
 */
export async function runGit({ argv, cwd, log, operation = 'Git command', stdin = null, signal = null, env = null }) {
  if (!validArguments(argv) || typeof cwd !== 'string' || !cwd) throw new TypeError('Invalid Git command');
  if (stdin !== null && typeof stdin !== 'string') throw new TypeError('Invalid Git command');
  if (env !== null && (typeof env !== 'object' || Object.values(env).some(value => typeof value !== 'string'))) {
    throw new TypeError('Invalid Git command');
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const id = randomUUID();
  const command = [...baseArgs, ...argv];
  const label = stdin === null ? operation : `${operation} · ${Buffer.byteLength(stdin, 'utf8')} bytes on stdin`;
  await log.start({ id, argv: command, cwd, operation: label, startedAt });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let abort = null;
    let cancelled = false;
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      if (signal && abort) signal.removeEventListener('abort', abort);
      const result = { argv: command, cwd, code, stdout, stderr, cancelled, ms: Math.round(performance.now() - started), startedAt };
      await log.finish(id, result);
      resolve(result);
    };
    let child;
    try {
      child = spawn('git', command, {
        cwd, shell: false, windowsHide: true,
        env: {
          ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: `"${process.execPath}" "${askpass}"`
        }
      });
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
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
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
