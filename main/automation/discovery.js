import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runGit } from '../git/exec.js';
import { HOOK_EVENTS } from '../../renderer/src/features/automations/event-labels.js';
import { normalizeConfig, validatePipeline } from '../../renderer/src/features/automations/schema.js';
import { parseCommand } from '../../renderer/src/features/automations/command-parse.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

const DISPATCH_MARK = 'TWIG AUTOMATION DISPATCHER';

/** A stable fingerprint of the bytes on disk; trust is bound to it. */
export function digestBytes(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

/** SHA-256 of a file of any size, read as a stream. */
function fileDigest(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The words of a command that can name a file: its arguments, and the value of `--option=value`. */
export function fileWords(action) {
  let argv = [];
  try {
    if (action.type === 'command' || action.type === 'custom') argv = parseCommand(action.command).slice(1);
    if (action.type === 'script' && action.args) argv = parseCommand(`x ${action.args}`).slice(1);
  } catch { return []; }
  return argv.map(word => (word.startsWith('-') ? word.split('=').slice(1).join('=') : word)).filter(Boolean);
}

/** The word as a file of the working tree, or null: outside it, not there, or not a regular file. */
async function repositoryFile(cwd, word) {
  const resolved = path.resolve(cwd, word);
  const relative = path.relative(cwd, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try { return (await stat(resolved)).isFile() ? resolved : null; } catch { return null; }
}

/**
 * Trust must cover what will run, not only the JSON that names it: a `script`
 * action runs a file of the repository, `sh tools/lint.sh` does the same with
 * one more word, and editing that file after approval would otherwise run new
 * code without a new prompt. So every script's bytes join the digest (a missing
 * file by a marker), and so does each file a command names as an argument,
 * whatever its size. The path hashed is the path run: nothing is trimmed here
 * that `runAction` does not trim. Without such files the digest is the JSON's
 * alone, so approvals of `npm test` made before this stay valid.
 */
async function configDigest(cwd, text, config) {
  const actions = config.pipelines.flatMap(pipeline => pipeline.actions);
  const scripts = [...new Set(actions.filter(action => action.type === 'script').map(action => action.path))].sort();
  const words = [...new Set(actions.flatMap(fileWords))].sort();
  const hash = createHash('sha256').update(text, 'utf8');
  for (const script of scripts) {
    let content;
    try { content = await fileDigest(path.resolve(cwd, script)); } catch { content = 'missing'; }
    hash.update(`\0${script}\0${content}`, 'utf8');
  }
  for (const word of words) {
    const file = await repositoryFile(cwd, word);
    if (file) hash.update(`\0${word}\0${await fileDigest(file).catch(() => 'missing')}`, 'utf8');
  }
  return hash.digest('hex');
}

/**
 * Reads `.twig/hooks.json` from the working tree. Returns the raw text, the
 * digest trust is bound to (the JSON plus every script it runs), the normalised
 * config and any parse error. Never executes anything.
 * @param {string} cwd repository working directory
 */
export async function readRepoConfig(cwd) {
  const file = path.join(cwd, '.twig', 'hooks.json');
  try {
    const text = await readFile(file, 'utf8');
    try {
      const config = normalizeConfig(JSON.parse(text), 'repo');
      // Held to the rules a pipeline made in 🌱 Twig is held to: what cannot be saved here cannot run from a file either.
      const problem = config.pipelines.flatMap(pipeline => validatePipeline(pipeline).errors)[0];
      if (problem) return { present: true, text, digest: digestBytes(text), config: null, error: ui`This repository’s .twig/hooks.json cannot be used. ${problem}` };
      return { present: true, text, digest: await configDigest(cwd, text, config), config, error: null };
    } catch {
      return { present: true, text, digest: digestBytes(text), config: null, error: ui`This repository’s .twig/hooks.json is not valid JSON.` };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, text: null, digest: null, config: null, error: null };
    return { present: false, text: null, digest: null, config: null, error: ui`Could not read .twig/hooks.json.` };
  }
}

/**
 * Classifies each of the ten hook files as absent / a Twig dispatcher / a
 * foreign script. Read-only in increment 1: Twig neither installs nor edits
 * these files yet, it only reports them so an existing hook is never a surprise.
 */
export async function discoverHooks({ cwd, log }) {
  const result = await runGit({ argv: ['rev-parse', '--git-path', 'hooks'], cwd, log, operation: 'Background: locate hooks directory' });
  if (result.code !== 0) return { hooksDir: null, hooks: [] };
  const hooksDir = path.resolve(cwd, result.stdout.trim());
  const hooks = [];
  for (const event of HOOK_EVENTS) {
    const hookFile = path.join(hooksDir, event.hook);
    try {
      const body = await readFile(hookFile, 'utf8');
      hooks.push({ name: event.hook, kind: body.includes(DISPATCH_MARK) ? 'twig' : 'foreign', body: body.slice(0, 20_000) });
    } catch (error) {
      if (error.code === 'ENOENT') hooks.push({ name: event.hook, kind: 'absent', body: null });
      else hooks.push({ name: event.hook, kind: 'unreadable', body: null });
    }
  }
  return { hooksDir, hooks };
}
