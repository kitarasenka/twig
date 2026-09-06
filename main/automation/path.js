import { spawn } from 'node:child_process';

/**
 * A GUI-launched Electron process on macOS (and often Linux) inherits a stub
 * `PATH` that does not include Homebrew, nvm, asdf or volta, so `npm`/`node`
 * that the user runs in a terminal would be "not found" here. This asks the
 * user's login shell for its `PATH` once at startup, with a fixed command and
 * no user input, and merges it with the process `PATH`.
 *
 * Windows keeps a full `PATH` for GUI apps, so this is a no-op there.
 * @returns {Promise<string>} the PATH string to hand automation steps
 */
export async function resolveLoginPath() {
  const current = process.env.PATH || '';
  if (process.platform === 'win32') return current;
  const shell = process.env.SHELL;
  if (!shell) return current;
  const fromShell = await new Promise(resolve => {
    let out = '';
    let done = false;
    const finish = value => { if (!done) { done = true; resolve(value); } };
    let child;
    try {
      child = spawn(shell, ['-lc', 'printf %s "$PATH"'], { windowsHide: true, timeout: 3000 });
    } catch { finish(''); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(''); }, 3000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { if (out.length < 8192) out += chunk; });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', code => { clearTimeout(timer); finish(code === 0 ? out.trim() : ''); });
  });
  const seen = new Set();
  return [...fromShell.split(':'), ...current.split(':')]
    .map(entry => entry.trim())
    .filter(entry => entry && !seen.has(entry) && seen.add(entry))
    .join(':');
}
