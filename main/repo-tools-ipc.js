import { app, dialog, ipcMain } from 'electron';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { isTrustedPage } from './security.js';
import { runGit } from './git/exec.js';
import { loadLfsStatus, pullLfs } from './git/lfs.js';
import { loadRepositoryStats, runMaintenance } from './git/maintenance.js';
import { MAINTENANCE_TASKS } from './git/maintenance-plan.js';
import { checkPatch, exportName, exportPatches, inspectPatch, readPatchFile, validateExport } from './git/patches.js';
import { loadSubmodules, submoduleDirectory, updateSubmodules } from './git/submodules.js';
import { addWorktree, agentBranch, findWorktree, folderName, loadWorktrees, pruneWorktrees, removeWorktree, suggestWorktreePath } from './git/worktrees.js';
import { compareWorktrees, excludeAgentFolder, finishWorktree, loadWorktreeBoard, loadWorktreeCompareDiff, loadWorktreeFileDiff, loadWorktreeReview, planSquash,
  squashWorktree } from './git/worktree-board.js';
import { validateOid } from './git/commit.js';
import { validateRefName } from './git/refs-ops.js';

/**
 * Channels for the repository tools beyond history: Git LFS, patches,
 * submodules, worktrees and maintenance. Like every other channel, each checks the sender,
 * its frame and the argument count, and resolves the repository only from the
 * saved list — a path from the renderer is never trusted as a repository.
 */
export function registerRepoToolsIpc(getWindow, entryUrl, { repositories, journal, undo, patchFiles, folders, pendingProposals = () => new Set(), connectedAgents = () => [] }) {
  const jobs = new Map();

  function repository(id) {
    if (typeof id !== 'string' || id.length > 4096) throw new TypeError('Invalid repository id');
    const item = repositories.snapshot().repositories.find(entry => entry.id === id);
    if (!item || !item.available) throw new TypeError('Repository is unavailable');
    return item;
  }
  function handler(channel, count, action) {
    ipcMain.handle(channel, (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count) throw new TypeError('Invalid repository tool request');
      const item = repository(args[0]);
      return action({ cwd: item.path, log: journal, repository: item }, ...args.slice(1));
    });
  }
  /** One long job per repository (LFS download, submodule update, maintenance), cancellable. */
  async function job(cwd, run) {
    if (jobs.has(cwd)) throw new Error('Another download or maintenance task is running in this repository.');
    const controller = new AbortController();
    jobs.set(cwd, controller);
    try { return await run(controller.signal); } finally { jobs.delete(cwd); }
  }

  handler('lfs:status', 1, options => loadLfsStatus(options));
  handler('lfs:pull', 1, options => job(options.cwd, signal => pullLfs({ ...options, signal })));
  /**
   * Export: the commits (oldest first) go into one mbox file wherever the
   * save dialog says; Git never learns the destination, main writes it.
   */
  handler('patch:export', 2, async (options, oids) => {
    validateExport(oids);
    const subject = oids.length === 1
      ? (await runGit({ ...options, argv: ['show', '-s', '--format=%s', oids[0], '--'], operation: 'Read commit subject' })).stdout.trim() : '';
    const choice = await dialog.showSaveDialog(getWindow(), {
      title: oids.length === 1 ? 'Export commit as a patch' : `Export ${oids.length} commits as a patch`,
      defaultPath: path.join(app.getPath('downloads'), exportName(oids, subject)),
      filters: [{ name: 'Patch', extensions: ['patch', 'mbox'] }]
    });
    if (choice.canceled || !choice.filePath) return { ok: false, cancelled: true, message: null };
    return exportPatches({ ...options, oids, target: choice.filePath });
  });
  /**
   * Import, step one: pick a file and say what it holds. Nothing is applied
   * here; the renderer gets a token and a description, never the path to send back.
   */
  handler('patch:choose', 1, async options => {
    const choice = await dialog.showOpenDialog(getWindow(), {
      title: 'Apply a patch', properties: ['openFile'],
      filters: [{ name: 'Patches', extensions: ['patch', 'diff', 'mbox', 'eml', 'txt'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const file = choice.filePaths[0];
    const content = await readPatchFile(file);
    const summary = inspectPatch(content);
    if (!summary.valid) return { name: path.basename(file), invalid: true, reason: 'This file holds no diff that Git could apply.' };
    const check = await checkPatch({ ...options, file });
    const token = patchFiles.add(options.cwd, { file, kind: summary.kind });
    return { token, name: path.basename(file), bytes: content.length, ...summary, check };
  });
  // --- submodules ------------------------------------------------------------------------------
  handler('submodules:list', 1, options => loadSubmodules(options));
  /** `null` updates every submodule; otherwise the named ones, checked against the index. */
  handler('submodules:update', 2, async (options, paths) => {
    if (paths !== null) {
      const known = new Set((await loadSubmodules(options)).map(entry => entry.path));
      if (!Array.isArray(paths) || !paths.length || paths.some(item => typeof item !== 'string' || !known.has(item))) throw new TypeError('Invalid submodule paths');
    }
    return job(options.cwd, signal => undo.perform(options.cwd, 'submodules:update', [], () => updateSubmodules({ ...options, paths, signal })));
  });
  /** Opens an initialized submodule as a repository tab of its own. */
  handler('submodules:open', 2, async (options, wanted) => repositories.add(await submoduleDirectory({ ...options, path: wanted })));

  // --- worktrees -------------------------------------------------------------------------------
  handler('worktrees:list', 1, options => loadWorktrees(options));
  /** The board: every worktree with its changes, how far it is from the base, and a waiting proposal. */
  handler('worktrees:board', 1, options => loadWorktreeBoard({ ...options, pending: pendingProposals(), agents: connectedAgents() }));
  /**
   * The folder a new worktree for `branch` would get — next to the main one,
   * inside a folder the person picks, or, for an agent, in the main
   * checkout's `.claude/worktrees/<name>` on a new branch `agent/<name>` —
   * held by a token, so what the dialog shows is exactly where Git will put it.
   */
  handler('worktrees:plan', 3, async (options, name, where) => {
    if (typeof name !== 'string' || !name || name.length > 255 || !['next', 'choose', 'agent'].includes(where)) throw new TypeError('Invalid worktree request');
    const branch = where === 'agent' ? validateRefName(agentBranch(name)) : name;
    let parent = null;
    if (where === 'choose') {
      const picked = await dialog.showOpenDialog(getWindow(), { title: 'Choose where the new worktree goes', properties: ['openDirectory', 'createDirectory'] });
      if (picked.canceled || !picked.filePaths[0]) return null;
      parent = picked.filePaths[0];
    }
    const main = (await loadWorktrees(options))[0].path;
    const folder = await suggestWorktreePath({ main, branch, parent, agent: where === 'agent' });
    return { token: folders.add(options.cwd, { folder, branch: folderName(branch), agent: where === 'agent' ? branch : null, main }), path: folder, branch };
  });
  /**
   * Adds the worktree. `create` makes `branch` a new branch at `startPoint`;
   * otherwise it must be a branch no other worktree has checked out (Git
   * refuses that, and says so). A worktree opens as a tab — except one for an
   * agent, which stays on the board: the agent works in it, not the person.
   */
  handler('worktrees:add', 2, async (options, request) => {
    if (!request || typeof request !== 'object' || typeof request.create !== 'boolean' || typeof request.branch !== 'string') throw new TypeError('Invalid worktree request');
    const planned = folders.take(options.cwd, request.token);
    if (planned.agent && (request.branch !== planned.agent || !request.create)) throw new TypeError('Invalid worktree request');
    const result = await undo.perform(options.cwd, 'worktrees:add', [], () => addWorktree({ ...options, path: planned.folder, branch: request.branch,
      create: request.create, startPoint: request.create ? request.startPoint : null }));
    if (!result.ok) return result;
    if (planned.agent) {
      // The main checkout would otherwise list the new folder as untracked.
      const excluded = await excludeAgentFolder({ cwd: planned.main, log: journal }).catch(() => ({ added: false }));
      return { ...result, agent: true, excluded: excluded.added ? excluded.rule : null };
    }
    return { ...result, workspace: await repositories.add(planned.folder) };
  });
  handler('worktrees:remove', 3, async (options, folder, force) => {
    if (typeof force !== 'boolean') throw new TypeError('Invalid worktree request');
    await findWorktree({ ...options, path: folder });
    const result = await undo.perform(options.cwd, 'worktrees:remove', [], () => removeWorktree({ ...options, path: folder, force }));
    if (!result.ok) return result;
    return { ...result, workspace: await closeTabOf(result.path) };
  });
  /** Removes a worktree whose work is in the base, and its branch. */
  handler('worktrees:finish', 2, async (options, folder) => {
    await findWorktree({ ...options, path: folder });
    const result = await undo.perform(options.cwd, 'worktrees:finish', [], () => finishWorktree({ ...options, folder }));
    if (!result.path) return result;
    return { ...result, workspace: await closeTabOf(result.path) };
  });
  handler('worktrees:prune', 1, options => undo.perform(options.cwd, 'worktrees:prune', [], () => pruneWorktrees(options)));
  /** Opens another worktree of this repository as a tab. */
  handler('worktrees:open', 2, async (options, folder) => {
    const found = await findWorktree({ ...options, path: folder });
    if (found.prunable) throw new Error('This worktree’s folder is gone. Prune it instead.');
    return repositories.add(found.path);
  });
  /** Everything a worktree changed since its branch left the base, and one file of it. */
  handler('worktrees:review', 2, (options, folder) => loadWorktreeReview({ ...options, folder }));
  handler('worktrees:file-diff', 4, (options, folder, file, untracked) => {
    if (typeof untracked !== 'boolean') throw new TypeError('Invalid worktree request');
    return loadWorktreeFileDiff({ ...options, folder, path: file, untracked });
  });
  /** Two worktrees side by side — two agents on the same task — and one file of the two as a diff. */
  handler('worktrees:compare', 3, (options, left, right) => compareWorktrees({ ...options, left, right }));
  handler('worktrees:compare-file', 4, (options, left, right, file) => loadWorktreeCompareDiff({ ...options, left, right, path: file }));
  /**
   * Squashing a worktree's branch into the base: the plan (commits, message,
   * commands, why not), then the squash itself with the tips the dialog showed.
   * It commits in the base worktree, so Undo there takes the commit back.
   */
  handler('worktrees:squash-plan', 2, (options, folder) => planSquash({ ...options, folder }));
  handler('worktrees:squash', 3, async (options, folder, request) => {
    if (!request || typeof request !== 'object' || typeof request.message !== 'string' || request.message.length > 100_000) throw new TypeError('Invalid squash request');
    validateOid(request.branchOid); validateOid(request.baseOid);
    const plan = await planSquash({ ...options, folder });
    if (plan.problem) return { ok: false, message: plan.problem };
    // Git names the base folder resolved; Undo keys on the folder as the tab holds it.
    const undoCwd = sameFolder(plan.basePath, options.cwd) ? options.cwd : plan.basePath;
    return undo.perform(undoCwd, 'worktree:commit', [], () => squashWorktree({ ...options, folder, message: request.message,
      branchOid: request.branchOid, baseOid: request.baseOid }));
  });

  function sameFolder(a, b) {
    const real = folder => { try { return realpathSync.native(folder); } catch { return path.resolve(folder); } };
    return real(a) === real(b);
  }
  // Its tab, if one was open, would only say "unavailable" now.
  async function closeTabOf(folder) {
    const tab = repositories.snapshot().repositories.find(entry => !entry.sandbox && path.resolve(entry.path) === path.resolve(folder));
    return tab ? repositories.remove(tab.id) : repositories.snapshot();
  }

  // --- maintenance -----------------------------------------------------------------------------
  handler('maintenance:stats', 1, options => loadRepositoryStats(options));
  /**
   * `optimize` or `gc`, never an argv: the command is fixed per task. It goes
   * through Undo's busy lock like any action; neither moves a ref, so a chain
   * of Undo steps survives it.
   */
  handler('maintenance:run', 2, (options, task) => {
    if (!MAINTENANCE_TASKS.includes(task)) throw new TypeError('Invalid maintenance task');
    return job(options.cwd, signal => undo.perform(options.cwd, `maintenance:${task}`, [], () => runMaintenance({ ...options, task, signal })));
  });

  handler('tools:cancel', 1, options => { jobs.get(options.cwd)?.abort(); return true; });
}
