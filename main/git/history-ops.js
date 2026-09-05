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
export const OPERATION_KINDS = ['merge', 'cherry-pick', 'revert', 'rebase'];
const SEQUENCER_STEPS = {
  merge: ['continue', 'abort'],
  'cherry-pick': ['continue', 'skip', 'abort'],
  revert: ['continue', 'skip', 'abort'],
  rebase: ['continue', 'skip', 'abort']
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
  merge: 'Merge', 'cherry-pick': 'Cherry-pick', revert: 'Revert', reset: 'Reset', rebase: 'Rebase'
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
