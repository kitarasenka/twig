import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from './exec.js';
import { validateOid } from './commit.js';

/**
 * Rebase, including the interactive one.
 *
 * Twig does not reimplement rebase: it installs itself as Git's
 * `GIT_SEQUENCE_EDITOR` and `GIT_EDITOR` and lets Git drive, exactly as the
 * brief requires. The plan the user approved is written to a file under the
 * app's own state directory — never inside the repository — and the sequence
 * editor copies it over the todo list Git offers.
 */

const sequenceEditor = fileURLToPath(new URL('./sequence-editor.cjs', import.meta.url));
const messageEditor = fileURLToPath(new URL('./message-editor.cjs', import.meta.url));

export const TODO_ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
const MELDING = new Set(['squash', 'fixup']);
const MAX_ENTRIES = 1000;

/** Quoted the way Git's own askpass hook is: Git runs these through a shell. */
const editorCommand = script => `"${process.execPath}" "${script}"`;

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new TypeError('Invalid rebase plan');
  }
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !TODO_ACTIONS.includes(entry.action)) throw new TypeError('Invalid rebase plan');
    validateOid(entry.oid);
    if (seen.has(entry.oid)) throw new TypeError('A commit appears twice in the rebase plan');
    seen.add(entry.oid);
    if (entry.action === 'reword' && (typeof entry.message !== 'string' || entry.message.trim().length === 0)) {
      throw new TypeError('A reworded commit needs a message');
    }
  }
  const kept = entries.filter(entry => entry.action !== 'drop');
  if (kept.length === 0) throw new TypeError('A rebase plan must keep at least one commit');
  // Git refuses a todo whose first command melds into a commit that the plan
  // does not contain, and refusing here explains it before the process starts.
  if (MELDING.has(kept[0].action)) throw new TypeError('The first commit cannot be squashed into the one before it');
  return entries;
}

/**
 * One `action oid` line per entry, oldest first — the order Git executes.
 * Full object ids are written on purpose: the message editor matches the step
 * Git reports in `done` against the prepared messages by id.
 * @param {{ action: string, oid: string, message?: string }[]} entries
 * @returns {string}
 */
export function buildTodo(entries) {
  validateEntries(entries);
  return `${entries.map(entry => `${entry.action} ${entry.oid}`).join('\n')}\n`;
}

/**
 * Messages keyed by object id rather than by position: Git calls the editor
 * once per squash chain instead of once per line, and a conflict inserts an
 * extra call at `--continue`, so a positional queue would drift.
 * @param {{ action: string, oid: string, message?: string }[]} entries
 * @returns {Record<string, string>}
 */
export function buildMessageMap(entries) {
  validateEntries(entries);
  return Object.fromEntries(entries
    .filter(entry => entry.action === 'reword')
    .map(entry => [entry.oid.toLowerCase(), entry.message]));
}

export function buildRebaseArgv({ oid, interactive = false }) {
  return ['rebase', ...(interactive ? ['--interactive'] : []), validateOid(oid)];
}

/** Plan files live per repository, keyed by a digest of its path, never inside it. */
export function planDirectory(stateDir, cwd) {
  return path.join(stateDir, 'rebase', createHash('sha256').update(cwd).digest('hex').slice(0, 16));
}

/**
 * The variables Git needs so that no step of an operation can fall through to
 * a terminal editor. `todoFile` is only set for an interactive start; every
 * other call still needs the message editor, because `--continue` opens one.
 */
export function buildEditorEnv({ gitDir, todoFile = null, messagesFile = null }) {
  return {
    GIT_EDITOR: editorCommand(messageEditor),
    TWIG_GIT_DIR: gitDir,
    ...(messagesFile ? { TWIG_REBASE_MESSAGES: messagesFile } : {}),
    ...(todoFile ? { GIT_SEQUENCE_EDITOR: editorCommand(sequenceEditor), TWIG_REBASE_TODO: todoFile } : {})
  };
}

/** @param {{ stateDir: string, cwd: string }} options */
export async function writePlan({ stateDir, cwd, entries }) {
  const directory = planDirectory(stateDir, cwd);
  await mkdir(directory, { recursive: true });
  const todoFile = path.join(directory, 'todo');
  const messagesFile = path.join(directory, 'messages.json');
  await writeFile(todoFile, buildTodo(entries), 'utf8');
  await writeFile(messagesFile, JSON.stringify(buildMessageMap(entries)), 'utf8');
  return { todoFile, messagesFile };
}

/** Called once an operation is over, so a finished plan cannot leak into the next one. */
export async function clearPlan({ stateDir, cwd }) {
  await rm(planDirectory(stateDir, cwd), { recursive: true, force: true });
}

/** The plan file of a rebase still in progress, needed by every `--continue`. */
export function planFiles({ stateDir, cwd }) {
  const directory = planDirectory(stateDir, cwd);
  return { todoFile: path.join(directory, 'todo'), messagesFile: path.join(directory, 'messages.json') };
}

/**
 * @param {{ cwd: string, log: object, gitDir: string, stateDir: string, oid: string,
 *   entries?: ?object[] }} options entries present means an interactive rebase
 * @returns {Promise<{ ok: boolean, stopped: boolean, message: ?string }>}
 */
export async function startRebase({ cwd, log, gitDir, stateDir, oid, entries = null }) {
  const interactive = entries !== null;
  // A plain rebase has no plan and no prepared messages, but it still needs
  // the message editor: its own `--continue` opens one after a conflict.
  const files = interactive ? await writePlan({ stateDir, cwd, entries }) : { todoFile: null, messagesFile: null };
  const env = buildEditorEnv({ gitDir, ...files });
  const result = await runGit({
    argv: buildRebaseArgv({ oid, interactive }), cwd, log, env,
    operation: interactive ? 'Interactive rebase · 🌱 Twig supplies the plan and messages' : 'Rebase'
  });
  if (result.code === 0) return { ok: true, stopped: false, message: null };
  return { ok: false, stopped: true, message: 'The rebase stopped. Resolve what it reports, then continue it.' };
}
