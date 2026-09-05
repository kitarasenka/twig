import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export async function runSsh({ executable, argv, cwd, log, stdin = '', signal, quiet = false }) {
  if (!['ssh', 'ssh-keygen'].includes(executable) || !Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new TypeError('Invalid SSH command');
  const id = randomUUID(); const startedAt = new Date().toISOString(); const started = performance.now();
  await log.start({ id, executable, argv, cwd, startedAt, operation: executable === 'ssh-keygen' ? 'Generate SSH key' : 'SSH command' });
  return new Promise((resolve, reject) => {
    let stdout = ''; let stderr = ''; let cancelled = false; let failure;
    const child = spawn(executable, argv, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      env: { ...process.env, SSH_ASKPASS_REQUIRE: 'never', SSH_ASKPASS: '', DISPLAY: '' } });
    const abort = () => {
      cancelled = true;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill(); }
      catch { child.kill(); }
    };
    const timer = setTimeout(abort, 30000);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {}); child.stdin.end(stdin);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length < 1_000_000) { stdout += chunk; if (!quiet) void log.output(id, 'stdout', chunk).catch(() => {}); } });
    child.stderr.on('data', chunk => { if (stderr.length < 1_000_000) { stderr += chunk; if (!quiet) void log.output(id, 'stderr', chunk).catch(() => {}); } });
    child.on('error', error => { failure = error; });
    child.on('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const result = { code: code ?? -1, stdout, stderr: failure ? `${stderr}${failure.message}` : stderr,
        cancelled, ms: Math.round(performance.now() - started), startedAt };
      try {
        await log.finish(id, quiet ? { ...result, stdout: '[Configuration output omitted from the journal.]', stderr: result.code ? 'SSH configuration validation failed.' : '' } : result);
        resolve(result);
      } catch (error) { reject(error); }
    });
  });
}
