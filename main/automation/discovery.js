import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runGit } from '../git/exec.js';
import { HOOK_EVENTS } from '../../renderer/src/features/automations/event-labels.js';
import { normalizeConfig } from '../../renderer/src/features/automations/schema.js';

const DISPATCH_MARK = 'TWIG AUTOMATION DISPATCHER';

/** A stable fingerprint of the bytes on disk; trust is bound to it. */
export function digestBytes(text) {
  return createHash('sha256').update(text ?? '', 'utf8').digest('hex');
}

const SCRIPT_DIGEST_BYTES = 4 * 1024 * 1024;

/**
 * Trust must cover what will run, not only the JSON that names it: a `script`
 * action runs a file of the repository, and editing that file after approval
 * would otherwise run new code without a new prompt. Each script's bytes join
 * the digest (a missing or huge file by a marker). Without script actions the
 * digest is the JSON's alone, so approvals made before this stay valid.
 */
async function configDigest(cwd, text, config) {
  const scripts = [...new Set(config.pipelines.flatMap(pipeline => pipeline.actions)
    .filter(action => action.type === 'script' && action.path.trim()).map(action => action.path.trim()))].sort();
  if (!scripts.length) return digestBytes(text);
  const hash = createHash('sha256').update(text, 'utf8');
  for (const script of scripts) {
    let content;
    try {
      const bytes = await readFile(path.resolve(cwd, script));
      content = bytes.length > SCRIPT_DIGEST_BYTES ? `large:${bytes.length}` : createHash('sha256').update(bytes).digest('hex');
    } catch { content = 'missing'; }
    hash.update(`\0${script}\0${content}`, 'utf8');
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
      return { present: true, text, digest: await configDigest(cwd, text, config), config, error: null };
    } catch {
      return { present: true, text, digest: digestBytes(text), config: null, error: 'This repository’s .twig/hooks.json is not valid JSON.' };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false, text: null, digest: null, config: null, error: null };
    return { present: false, text: null, digest: null, config: null, error: 'Could not read .twig/hooks.json.' };
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
