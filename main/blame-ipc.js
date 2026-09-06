import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { runGit } from './git/exec.js';
import { loadBlame, loadReverseBlame, loadBlameBefore, BlameError } from './git/blame.js';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/**
 * Read-only blame channels: regular blame, reverse blame and the "blame
 * before this change" step. Nothing here checks out, stages or moves a ref —
 * every command is a `git blame`, `git rev-parse`, `git cat-file -e`,
 * `git merge-base` or `git diff`.
 *
 * One in-flight blame per repository: a new request aborts the previous one,
 * which both frees the process and means a stale answer can never overwrite a
 * newer screen. `blame:cancel` aborts on demand (screen closed, mode switched).
 */
export function registerBlameIpc(getWindow, entryUrl, { repositories, journal }) {
  const running = new Map();

  function begin(cwd) {
    running.get(cwd)?.abort();
    const controller = new AbortController();
    running.set(cwd, controller);
    return controller;
  }
  function end(cwd, controller) {
    if (running.get(cwd) === controller) running.delete(cwd);
  }

  function handler(channel, count, read) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count
        || typeof args[0] !== 'string') throw new Error('Invalid blame request');
      const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
      if (!repo || !repo.available) throw new Error('Repository is unavailable');
      return read({ cwd: repo.path, log: journal }, ...args.slice(1));
    });
  }

  const asOid = value => {
    if (typeof value !== 'string' || !OID.test(value)) throw new Error('Invalid object id');
    return value;
  };
  const asPath = value => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 32768
      || value.includes('\0') || value.startsWith('/') || value.split('/').some(part => part === '..')) {
      throw new Error('Invalid file path');
    }
    return value;
  };
  const asRef = value => {
    // One argv token to `rev-parse --verify`, never near `--` and never a
    // pathspec, so relative forms like `main~3` are allowed; whitespace, NUL,
    // a leading dash, `:` and `..` are not.
    if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value.startsWith('-')
      || value.includes('..') || /[\s\0:?*[\\]/.test(value)) throw new Error('Invalid revision');
    return value;
  };

  handler('blame:file', 3, async (options, oid, path) => {
    asOid(oid); asPath(path);
    const controller = begin(options.cwd);
    try { return await loadBlame({ ...options, oid, path, signal: controller.signal }); }
    finally { end(options.cwd, controller); }
  });

  handler('blame:before', 5, async (options, oid, path, line, parentIndex) => {
    asOid(oid); asPath(path);
    if (!Number.isInteger(line) || line < 1) throw new Error('Invalid line number');
    if (parentIndex !== null && (!Number.isInteger(parentIndex) || parentIndex < 0)) throw new Error('Invalid parent index');
    const controller = begin(options.cwd);
    try { return await loadBlameBefore({ ...options, oid, path, line, parentIndex, signal: controller.signal }); }
    catch (error) {
      if (error instanceof TypeError) throw error;
      if (error instanceof BlameError) return { kind: 'error', code: error.code, message: error.message };
      throw error;
    }
    finally { end(options.cwd, controller); }
  });

  const resolve = async (cwd, ref, signal) => {
    const out = await runGit({ argv: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, log: journal, operation: 'Resolve blame revision', signal });
    const oid = out.stdout.trim();
    if (out.code !== 0 || !OID.test(oid)) throw new Error(`Cannot resolve “${ref}” to a commit.`);
    return oid;
  };

  /**
   * Resolves both ends to full object ids before anything is computed, checks
   * that Start is an ancestor of End and that the file exists in Start, and
   * treats Start == End as its own valid case (every line is "present at end").
   */
  handler('blame:reverse', 4, async (options, startRef, endRef, path) => {
    asRef(startRef); asRef(endRef); asPath(path);
    const controller = begin(options.cwd);
    try {
      const startOid = await resolve(options.cwd, startRef, controller.signal);
      const endOid = await resolve(options.cwd, endRef, controller.signal);

      const start = await runGit({ argv: ['cat-file', '-e', `${startOid}:${path}`], cwd: options.cwd, log: journal, operation: 'Check file at start', signal: controller.signal });
      if (start.code !== 0) throw new Error('The file does not exist in the Start commit.');

      if (startOid === endOid) {
        const blame = await loadBlame({ ...options, oid: startOid, path, signal: controller.signal });
        return { ...blame, mode: 'reverse', startOid, endOid, endRef, endAtStart: true };
      }

      const ancestor = await runGit({ argv: ['merge-base', '--is-ancestor', startOid, endOid], cwd: options.cwd, log: journal, operation: 'Check reverse-blame range', signal: controller.signal });
      if (ancestor.code === 1) throw new Error('Start is not an ancestor of End. Pick an End that comes after Start.');
      if (ancestor.code !== 0) throw new Error('Git could not compare the two commits. Show output in the console.');

      const blame = await loadReverseBlame({ ...options, startOid, endOid, path, signal: controller.signal });
      return { ...blame, endRef };
    } catch (error) {
      // Input that is not valid Git at all is refused by asRef/asPath above,
      // before this block. Everything here — an unresolvable ref, a range that
      // is not ancestor→descendant, a file missing in Start — is a real answer
      // the user needs to read, so it comes back as a reason, not a rejection.
      if (error instanceof TypeError) throw error;
      return { kind: 'error', code: error instanceof BlameError ? error.code : 'range', message: error.message };
    } finally { end(options.cwd, controller); }
  });

  handler('blame:cancel', 1, options => { running.get(options.cwd)?.abort(); return true; });
}
