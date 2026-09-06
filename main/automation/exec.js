import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const STREAM_CAP = 1_000_000;

/**
 * Runs one automation step as a single process — never through a shell. `argv`
 * is already a tokenised command (`parseCommand` did that); `argv[0]` is the
 * program, resolved by the OS through `PATH`, or an absolute path the caller has
 * already checked lies inside the working tree.
 *
 * Every run is mirrored into the command journal with an `executable` marker so
 * the console shows exactly what ran, next to the Git commands. Output is capped
 * in memory; the runs store caps again on disk.
 *
 * @param {{ argv: string[], cwd: string, log: object, env?: Record<string,string>,
 *   signal?: AbortSignal, timeoutMs?: number, operation?: string }} options
 * @returns {Promise<{ code: number, stdout: string, stderr: string,
 *   cancelled: boolean, timedOut: boolean, ms: number }>}
 */
export function runStep({ argv, cwd, log, env = {}, signal, timeoutMs = 120_000, operation = 'Automation step' }) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(part => typeof part !== 'string')) {
    throw new TypeError('Invalid automation command.');
  }
  if (typeof cwd !== 'string' || !cwd) throw new TypeError('Invalid working directory.');
  const [executable, ...args] = argv;
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let cancelled = false;
    let timedOut = false;
    let failure = null;
    let settled = false;

    void log.start({ id, executable, argv, cwd, startedAt, operation });

    let child;
    try {
      child = spawn(executable, args, {
        cwd, shell: false, windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...env, TWIG_AUTOMATION: '1' }
      });
    } catch (error) {
      void log.output(id, 'stderr', error.message);
      void log.finish(id, { code: -1, stdout: '', stderr: error.message, cancelled: false, ms: Math.round(performance.now() - started), startedAt });
      resolve({ code: -1, stdout: '', stderr: error.message, cancelled: false, timedOut: false, ms: Math.round(performance.now() - started) });
      return;
    }

    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
        else child.kill();
      } catch { try { child.kill(); } catch { /* already gone */ } }
    };
    const abort = () => { cancelled = true; void log.output(id, 'stderr', 'Cancelled in 🌱 Twig.\n'); kill(); };
    const timer = setTimeout(() => { timedOut = true; void log.output(id, 'stderr', `Timed out after ${Math.round(timeoutMs / 1000)}s.\n`); kill(); }, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });

    child.stdin.on('error', () => {});
    child.stdin.end();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length < STREAM_CAP) { stdout += chunk; void log.output(id, 'stdout', chunk); } });
    child.stderr.on('data', chunk => { if (stderr.length < STREAM_CAP) { stderr += chunk; void log.output(id, 'stderr', chunk); } });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const finalStderr = failure ? `${stderr}${failure.message}` : stderr;
      const ms = Math.round(performance.now() - started);
      const result = { code: timedOut ? -1 : code ?? -1, stdout, stderr: finalStderr, cancelled, timedOut, ms };
      void log.finish(id, { ...result, startedAt });
      resolve(result);
    });
  });
}
