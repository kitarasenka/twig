import { runGit } from './exec.js';
import { COUNT_OBJECTS_ARGV, maintenanceCommands, parseCountObjects } from './maintenance-plan.js';

/**
 * Repository maintenance by button: the size of the object store before and
 * after, and the command in between (see maintenance-plan.js for what each
 * one does and does not delete). Both run through `runGit`, so the console
 * shows them and the Cancel button stops them the way it stops a download —
 * Git keeps a repack or a gc safe to interrupt with its lock files.
 */

const LABELS = { optimize: 'Optimize repository', gc: 'Clean up repository' };

/** @param {{ cwd: string, log: object }} options */
export async function loadRepositoryStats({ cwd, log }) {
  const result = await runGit({ argv: [...COUNT_OBJECTS_ARGV], cwd, log, operation: 'Read repository size' });
  if (result.code !== 0) throw new Error('Git could not measure this repository.');
  return parseCountObjects(result.stdout);
}

/**
 * @param {{ cwd: string, log: object, task: 'optimize' | 'gc', signal?: AbortSignal }} options
 * @returns {Promise<{ ok: boolean, cancelled?: boolean, message: ?string, before: object, after: ?object, ms: number }>}
 */
export async function runMaintenance({ cwd, log, task, signal = null }) {
  const commands = maintenanceCommands(task);
  const before = await loadRepositoryStats({ cwd, log });
  if (signal?.aborted) return { ok: false, cancelled: true, notStarted: true, message: 'Cancelled before Git started.', before, after: null, ms: 0 };
  const started = Date.now();
  let failed = null;
  for (const argv of commands) {
    const result = await runGit({ argv, cwd, log, operation: `${LABELS[task]}: git ${argv[0]}`, signal });
    if (result.cancelled || signal?.aborted) { failed = 'cancelled'; break; }
    if (result.code !== 0) { failed = 'failed'; break; }
  }
  const ms = Date.now() - started;
  const after = await loadRepositoryStats({ cwd, log }).catch(() => null);
  if (failed === 'cancelled') return { ok: false, cancelled: true, message: `${LABELS[task]} was cancelled. Git leaves the repository in a consistent state.`, before, after, ms };
  if (failed) return { ok: false, message: `${LABELS[task]} did not finish. Show output in the console.`, before, after, ms };
  return { ok: true, message: null, before, after, ms };
}
