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
 * @param {{ argv: string[], cwd: string, log: import('../command-log.js').CommandLog, operation?: string }} options
 */
export async function runGit({ argv, cwd, log, operation = 'Git command' }) {
  if (!validArguments(argv) || typeof cwd !== 'string' || !cwd) throw new TypeError('Invalid Git command');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const id = randomUUID();
  const command = [...baseArgs, ...argv];
  await log.start({ id, argv: command, cwd, operation, startedAt });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      const result = { argv: command, cwd, code, stdout, stderr, ms: Math.round(performance.now() - started), startedAt };
      await log.finish(id, result);
      resolve(result);
    };
    let child;
    try {
      child = spawn('git', command, {
        cwd, shell: false, windowsHide: true,
        env: {
          ...process.env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: `"${process.execPath}" "${askpass}"`
        }
      });
    } catch (error) {
      stderr = error.message;
      void log.output(id, 'stderr', stderr).finally(() => void finish(-1));
      return;
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
