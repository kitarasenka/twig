import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { runGit } from './git/exec.js';
import { checkReadOnly, tokenize } from './git/read-only-command.js';

/**
 * `console:run-command` lets the user type a git command into the console. Only
 * a read-only one: the string is tokenised without a shell and checked against
 * the allowlist here — main never trusts the renderer's own check. A parser or
 * allowlist rejection throws, so a disallowed command is a refused request, not
 * a fake console entry. Anything that runs goes through the one Git executor and
 * lands in the journal like every other command.
 */
export function registerConsoleIpc(getWindow, entryUrl, { repositories, journal }) {
  ipcMain.handle('console:run-command', async (event, ...args) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== 2
      || typeof args[0] !== 'string' || typeof args[1] !== 'string' || args[1].length > 4096) {
      throw new Error('Invalid console command request');
    }
    const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
    if (!repo || !repo.available) throw new Error('Repository is unavailable');

    const argv = tokenize(args[1]);
    const verdict = checkReadOnly(argv);
    if (!verdict.ok) throw new Error(verdict.reason);

    const result = await runGit({ argv, cwd: repo.path, log: journal, operation: 'Console command' });
    return { code: result.code, ms: result.ms };
  });
}
