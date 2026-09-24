import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { UndoService } from '../../main/undo.js';
import { AUTO_LOOSE, AUTO_PACKS, COUNT_OBJECTS_ARGV, MAINTENANCE_TASKS, formatBytes, maintenanceAdvice, maintenanceCommands, maintenanceText, parseCountObjects } from '../../main/git/maintenance-plan.js';
import { loadRepositoryStats, runMaintenance } from '../../main/git/maintenance.js';

// Maintenance by button: the object store in numbers, and Git's own clean-up.

// --- commands and parsing, no Git ------------------------------------------------------------
assert.deepEqual(MAINTENANCE_TASKS, ['optimize', 'gc']);
assert.deepEqual(maintenanceCommands('optimize'), [['maintenance', 'run', '--task=commit-graph', '--task=loose-objects', '--task=incremental-repack'], ['prune-packed']]);
assert.ok(!maintenanceCommands('optimize').flat().some(word => /^gc$|--task=gc|--prune|^prune$/.test(word)), 'Optimize never runs gc or prunes unreachable objects');
assert.deepEqual(maintenanceCommands('gc'), [['gc']], 'plain gc: Git\'s default two-week grace period, never --prune=now');
for (const bad of ['prune', 'gc --aggressive', '', null]) assert.throws(() => maintenanceCommands(bad), TypeError);
{ const copy = maintenanceCommands('gc'); copy[0].push('--prune=now'); assert.deepEqual(maintenanceCommands('gc'), [['gc']], 'callers get copies and cannot change the command'); }
assert.deepEqual(maintenanceText('optimize'), ['git maintenance run --task=commit-graph --task=loose-objects --task=incremental-repack', 'git prune-packed']);
assert.deepEqual([...COUNT_OBJECTS_ARGV], ['count-objects', '-v']);
const sample = 'count: 12\nsize: 48\nin-pack: 300\npacks: 2\nsize-pack: 1024\nprune-packable: 3\ngarbage: 1\nsize-garbage: 4\nfuture-key: 9\n';
assert.deepEqual(parseCountObjects(sample), {
  loose: 12, looseBytes: 48 * 1024, packed: 300, packs: 2, packBytes: 1024 * 1024, prunable: 3, garbage: 1, garbageBytes: 4096,
  objects: 312, diskBytes: 48 * 1024 + 1024 * 1024 + 4096
}, 'sizes are KiB; unknown keys are ignored');
assert.throws(() => parseCountObjects('fatal: not a git repository'), /Unexpected/);
assert.equal(formatBytes(0), '0 B'); assert.equal(formatBytes(512), '512 B'); assert.equal(formatBytes(1536), '1.5 KB');
assert.equal(formatBytes(5 * 1024 ** 2), '5.0 MB'); assert.equal(formatBytes(250 * 1024 ** 3), '250 GB');
const quiet = parseCountObjects(sample.replace('garbage: 1', 'garbage: 0'));
assert.equal(maintenanceAdvice(quiet), null, 'nothing is due in a small, tidy repository');
assert.match(maintenanceAdvice({ ...quiet, loose: AUTO_LOOSE }), /loose objects/);
assert.match(maintenanceAdvice({ ...quiet, packs: AUTO_PACKS }), /packs/);
assert.match(maintenanceAdvice(parseCountObjects(sample)), /garbage/);

// --- a real repository -----------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-maintenance-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const undo = new UndoService({ directory: root, log }); await undo.load();
  const options = { cwd, log };
  const git = async argv => { const result = await runGit({ ...options, argv }); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Twig Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['gc.auto', '0'], ['maintenance.auto', 'false']]) await git(['config', key, value]);
  for (let i = 0; i < 20; i += 1) {
    await writeFile(path.join(cwd, `f${i}.txt`), `${'content '.repeat(200)}${i}\n`);
    await git(['add', '.']); await git(['commit', '-q', '-m', `c${i}`]);
  }
  // A commit on no branch — what the Reflog screen recovers. Optimize must keep it.
  await git(['checkout', '-q', '--detach']);
  await writeFile(path.join(cwd, 'lost.txt'), 'lost work\n'); await git(['add', '.']); await git(['commit', '-q', '-m', 'lost']);
  const lost = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['checkout', '-q', 'main']);

  const start = await loadRepositoryStats(options);
  assert.ok(start.loose > 60, 'every object is loose before any maintenance');
  assert.equal(start.packs, 0);
  assert.ok(start.diskBytes > 0);

  // Undo work recorded before maintenance must survive it.
  await writeFile(path.join(cwd, 'f0.txt'), 'edited\n'); await git(['add', 'f0.txt']);
  await undo.perform(cwd, 'worktree:commit', [], async () => { await git(['commit', '-q', '-m', 'recorded']); return true; });
  assert.equal((await undo.inspect(cwd)).undo, true);

  const optimized = await undo.perform(cwd, 'maintenance:optimize', [], () => runMaintenance({ ...options, task: 'optimize' }));
  assert.equal(optimized.ok, true, optimized.message);
  assert.ok(optimized.after.packs >= 1, 'loose objects were packed');
  // Only the recorded commit's objects and the detached one may still be loose:
  // the task packs a batch, and prune-packed drops the copies it packed.
  assert.ok(optimized.after.loose < optimized.before.loose / 4, `loose objects: ${optimized.before.loose} → ${optimized.after.loose}`);
  assert.equal(optimized.after.prunable, 0, 'no loose copy of a packed object is left behind');
  assert.equal((await runGit({ ...options, argv: ['cat-file', '-e', `${lost}^{commit}`] })).code, 0, 'the commit on no branch is still there');
  assert.equal((await undo.inspect(cwd)).undo, true, 'Optimize does not end the Undo chain');

  const cleaned = await undo.perform(cwd, 'maintenance:gc', [], () => runMaintenance({ ...options, task: 'gc' }));
  assert.equal(cleaned.ok, true, cleaned.message);
  assert.equal(cleaned.after.loose, 0, 'gc leaves nothing loose that anything reaches');
  assert.equal(cleaned.after.packs, 1, 'one pack');
  assert.equal((await runGit({ ...options, argv: ['cat-file', '-e', `${lost}^{commit}`] })).code, 0, 'within the two-week grace period gc keeps it too');
  assert.equal((await undo.inspect(cwd)).undo, true, 'gc does not end the Undo chain either');
  await undo.move(cwd, 'undo', async () => true);
  assert.equal((await git(['log', '-1', '--format=%s'])).trim(), 'c19', 'and the recorded commit can still be undone');

  // Cancelled before Git starts: nothing runs.
  const controller = new AbortController(); controller.abort();
  const cancelled = await runMaintenance({ ...options, task: 'gc', signal: controller.signal });
  assert.deepEqual([cancelled.ok, cancelled.cancelled, cancelled.after], [false, true, null]);
  await assert.rejects(() => runMaintenance({ ...options, task: 'prune' }), TypeError);

  const journal = await readFile(path.join(root, 'command-log.jsonl'), 'utf8');
  assert.match(journal, /Clean up repository: git gc/);
  assert.match(journal, /"maintenance","run","--task=commit-graph"/, 'the console shows the exact commands');

  const screen = await readFile(new URL('../../renderer/src/features/tools/MaintenanceScreen.jsx', import.meta.url), 'utf8');
  assert.match(screen, /command: maintenanceCommands\('gc'\)\[0\]/, 'the gc confirmation prints the command main runs');
  assert.match(screen, /window\.twig\.cancelRepositoryTool/);
  const ipc = await readFile(new URL('../../main/repo-tools-ipc.js', import.meta.url), 'utf8');
  assert.match(ipc, /handler\('maintenance:run', 2,/);
  assert.match(ipc, /MAINTENANCE_TASKS\.includes\(task\)/, 'main accepts a task name, never argv');
  console.log('maintenance check: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
