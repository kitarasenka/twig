import { runGit } from './exec.js';
import { validateOid } from './commit.js';
import { validateRefName } from './refs-ops.js';
import { buildEditorEnv } from './rebase.js';

/**
 * The operations that move or rewrite history: merge, cherry-pick, revert,
 * reset, and the continue/skip/abort that follow when one of them stops.
 *
 * Every one of these can end at an editor. `git merge --continue` takes no
 * other argument at all — `--no-edit` is rejected — so the only way to keep
 * Git from falling through to vi is to hand it an editor of our own for each
 * call, which is what `buildEditorEnv` is for.
 */

export const RESET_MODES = ['soft', 'mixed', 'hard'];
export const OPERATION_KINDS = ['merge', 'cherry-pick', 'revert', 'rebase', 'am'];
const SEQUENCER_STEPS = {
  merge: ['continue', 'abort'],
  'cherry-pick': ['continue', 'skip', 'abort'],
  revert: ['continue', 'skip', 'abort'],
  rebase: ['continue', 'skip', 'abort'],
  am: ['continue', 'skip', 'abort']
};

/** `reset --hard` throws away uncommitted work, so §6.5 requires a dialog before it. */
export const DESTRUCTIVE_RESET = 'hard';

/** A merge target may be a branch, a remote-tracking branch, a tag or a raw commit. */
export function validateRevision(revision) {
  if (typeof revision === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) return revision;
  return validateRefName(revision);
}

export function buildMergeArgv(revision, { noFf = false } = {}) {
  return ['merge', '--no-edit', ...(noFf ? ['--no-ff'] : []), validateRevision(revision)];
}

export function buildCherryPickArgv(oid) {
  return ['cherry-pick', validateOid(oid)];
}

/**
 * A merge commit has no single "the" change to undo, so Git demands
 * `--mainline` to say which parent the revert is relative to. The UI only
 * offers it for a commit it already knows has more than one parent.
 */
export function buildRevertArgv(oid, mainline = null) {
  if (mainline !== null && (!Number.isInteger(mainline) || mainline < 1 || mainline > 16)) {
    throw new TypeError('Invalid mainline parent');
  }
  return ['revert', '--no-edit', ...(mainline === null ? [] : ['--mainline', String(mainline)]), validateOid(oid)];
}

/** The most commits one cherry-pick or revert of a selection may name. */
export const MAX_PICKED = 100;

function pickedOids(oids) {
  if (!Array.isArray(oids) || oids.length < 2 || oids.length > MAX_PICKED) throw new TypeError('Choose between 2 and 100 commits');
  oids.forEach(validateOid);
  if (new Set(oids.map(oid => oid.toLowerCase())).size !== oids.length) throw new TypeError('A commit is named twice');
  return oids;
}

/**
 * Several selected commits in one sequencer run. Git applies them in the order
 * they are named, not by date, so the caller names them oldest first — the
 * order they were made in — and a conflict stops on the one that caused it,
 * with the rest still queued behind `cherry-pick --continue`.
 */
export function buildCherryPickManyArgv(oids) {
  return ['cherry-pick', ...pickedOids(oids)];
}

/**
 * Reverting a run is done newest first: each revert then undoes a change that
 * nothing later in the run still builds on, which is what keeps it from
 * conflicting with itself. One revert commit per reverted commit, as the
 * single-commit revert does. Merge commits are refused before this point —
 * each would need its own `--mainline`.
 */
export function buildRevertManyArgv(oids) {
  return ['revert', '--no-edit', ...pickedOids(oids)];
}

export function buildResetArgv(mode, oid) {
  if (!RESET_MODES.includes(mode)) throw new TypeError('Unknown reset mode');
  return ['reset', `--${mode}`, validateOid(oid)];
}

export function buildSequencerArgv(kind, step) {
  const steps = Object.hasOwn(SEQUENCER_STEPS, kind) ? SEQUENCER_STEPS[kind] : null;
  if (!steps || !steps.includes(step)) throw new TypeError('This operation cannot be continued that way');
  return [kind, `--${step}`];
}

export const sequencerSteps = kind => (Object.hasOwn(SEQUENCER_STEPS, kind) ? [...SEQUENCER_STEPS[kind]] : []);

const LABELS = {
  merge: 'Merge', 'cherry-pick': 'Cherry-pick', revert: 'Revert', reset: 'Reset', rebase: 'Rebase', am: 'Apply patches (am)'
};

/**
 * A failure here is usually not an error: a conflict is the expected outcome
 * of merging divergent work. The caller pairs this result with a fresh
 * `loadOperationState`, which is what tells the two apart.
 * @returns {Promise<{ ok: boolean, message: ?string }>}
 */
async function run({ cwd, log, gitDir, argv, operation, messagesFile = null }) {
  const result = await runGit({ argv, cwd, log, operation, env: buildEditorEnv({ gitDir, messagesFile }) });
  if (result.code === 0) return { ok: true, message: null };
  return { ok: false, message: `${operation} did not finish. Show output in the console.` };
}

/** @param {{ cwd: string, log: object, gitDir: string, revision: string, noFf?: boolean }} options */
export function merge({ cwd, log, gitDir, revision, noFf = false }) {
  return run({ cwd, log, gitDir, argv: buildMergeArgv(revision, { noFf }), operation: LABELS.merge });
}

/** @param {{ cwd: string, log: object, gitDir: string, oid: string }} options */
export function cherryPick({ cwd, log, gitDir, oid }) {
  return run({ cwd, log, gitDir, argv: buildCherryPickArgv(oid), operation: LABELS['cherry-pick'] });
}

/** @param {{ cwd: string, log: object, gitDir: string, oid: string, mainline?: ?number }} options */
export function revert({ cwd, log, gitDir, oid, mainline = null }) {
  return run({ cwd, log, gitDir, argv: buildRevertArgv(oid, mainline), operation: LABELS.revert });
}

/**
 * Which of these commits have more than one parent, in one `rev-list`.
 * `--no-walk=unsorted` lists only the named commits, and `--min-parents=2`
 * keeps the merges among them.
 */
export async function findMergeCommits({ cwd, log, oids }) {
  pickedOids(oids);
  const result = await runGit({ cwd, log, argv: ['rev-list', '--no-walk=unsorted', '--min-parents=2', ...oids, '--'], operation: 'Background: check the selection for merge commits' });
  if (result.code !== 0) throw new Error('Git could not read the selected commits.');
  return result.stdout.split('\n').filter(Boolean);
}

/** @param {{ cwd: string, log: object, gitDir: string, oids: string[] }} options oldest first */
export function cherryPickMany({ cwd, log, gitDir, oids }) {
  return run({ cwd, log, gitDir, argv: buildCherryPickManyArgv(oids), operation: `Cherry-pick ${oids.length} commits` });
}

/** @param {{ cwd: string, log: object, gitDir: string, oids: string[] }} options newest first */
export function revertMany({ cwd, log, gitDir, oids }) {
  return run({ cwd, log, gitDir, argv: buildRevertManyArgv(oids), operation: `Revert ${oids.length} commits` });
}

/** @param {{ cwd: string, log: object, gitDir: string, mode: string, oid: string }} options */
export function reset({ cwd, log, gitDir, mode, oid }) {
  return run({ cwd, log, gitDir, argv: buildResetArgv(mode, oid), operation: `${LABELS.reset} --${mode}` });
}

/** @param {{ cwd: string, log: object, gitDir: string, kind: string, step: string, messagesFile?: ?string }} options */
export function sequencer({ cwd, log, gitDir, kind, step, messagesFile = null }) {
  return run({
    cwd, log, gitDir, messagesFile,
    argv: buildSequencerArgv(kind, step),
    operation: `${LABELS[kind]} --${step}`
  });
}
