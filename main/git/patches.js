import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateOid } from './commit.js';

/**
 * Patches: work carried between repositories without a shared remote.
 *
 * Export writes one mbox file of `git format-patch` messages — one per
 * commit, oldest first — which `git am` turns back into the same commits
 * (author, date and message included) anywhere else. Each commit is formatted
 * into a private temporary folder and the result is joined as bytes, so a
 * file in any encoding survives unchanged; nothing is decoded on the way.
 *
 * Import reads a chosen file and applies it: an mbox with `git am --3way`
 * (commits, stopping on a conflict with the usual banner), a plain diff with
 * `git apply` (files only, all or nothing).
 */

export const MAX_EXPORTED = 100;
/** Bigger than any patch a person would read; a file over this is refused before Git sees it. */
export const MAX_PATCH_BYTES = 50 * 1024 * 1024;

/** A subject as a file name: `Fix the login form` → `fix-the-login-form`. */
export function slug(subject) {
  return String(subject).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52).replace(/-+$/, '') || 'patch';
}

/** The name the save dialog suggests. */
export function exportName(oids, subject) {
  return oids.length === 1 ? `${oids[0].slice(0, 7)}-${slug(subject)}.patch` : `${oids.length}-commits-from-${oids[0].slice(0, 7)}.patch`;
}

export function validateExport(oids) {
  if (!Array.isArray(oids) || oids.length < 1 || oids.length > MAX_EXPORTED) throw new TypeError('Choose between 1 and 100 commits to export');
  oids.forEach(validateOid);
  if (new Set(oids.map(oid => oid.toLowerCase())).size !== oids.length) throw new TypeError('A commit is named twice');
  return oids;
}

/** `git format-patch` for one commit, numbered as its place in the series. */
export function buildFormatPatchArgv(oid, number, directory) {
  if (!Number.isInteger(number) || number < 1 || number > MAX_EXPORTED) throw new TypeError('Invalid patch number');
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('Invalid patch directory');
  return ['format-patch', '--output-directory', directory, `--start-number=${number}`, '-1', validateOid(oid)];
}

/**
 * @param {{ cwd: string, log: object, oids: string[], target: string }} options oids oldest first; target from the save dialog
 * @returns {Promise<{ ok: boolean, message: ?string, count: number, bytes: number, path: ?string }>}
 */
export async function exportPatches({ cwd, log, oids, target }) {
  validateExport(oids);
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new TypeError('Invalid export destination');
  // A merge has no single diff; `git am` could not rebuild it from one.
  const merges = await runGit({ cwd, log, argv: ['rev-list', '--no-walk=unsorted', '--min-parents=2', ...oids, '--'], operation: 'Background: check the selection for merge commits' });
  if (merges.code !== 0) return { ok: false, message: 'Git could not read the selected commits.', count: 0, bytes: 0, path: null };
  if (merges.stdout.trim()) return { ok: false, message: `${merges.stdout.trim().slice(0, 7)} is a merge commit and cannot be exported as a patch. Leave merge commits out of the selection.`, count: 0, bytes: 0, path: null };
  const directory = await mkdtemp(path.join(os.tmpdir(), 'twig-format-patch-'));
  try {
    for (const [index, oid] of oids.entries()) {
      const result = await runGit({ cwd, log, argv: buildFormatPatchArgv(oid, index + 1, directory), operation: `Export ${oid.slice(0, 7)} as a patch` });
      if (result.code !== 0) return { ok: false, message: `Git could not format ${oid.slice(0, 7)}. Show output in the console.`, count: 0, bytes: 0, path: null };
    }
    const files = (await readdir(directory)).filter(name => name.endsWith('.patch')).sort();
    if (files.length !== oids.length) return { ok: false, message: 'Git did not write a patch for every commit. Show output in the console.', count: 0, bytes: 0, path: null };
    const content = Buffer.concat(await Promise.all(files.map(name => readFile(path.join(directory, name)))));
    await writeFile(target, content);
    return { ok: true, message: null, count: files.length, bytes: content.length, path: target };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/**
 * What a patch file holds, for the confirmation before it is applied: an
 * mbox of commits (`From <sha> …` messages, for `git am`) or a plain diff
 * (for `git apply`), and the files it touches.
 * @param {Buffer|string} content
 */
export function inspectPatch(content) {
  const text = Buffer.isBuffer(content) ? content.toString('latin1') : String(content);
  const mbox = /^From [0-9a-f]{40,64} /.test(text) || /^From: .+\n(?:.+\n)*?Subject: /m.test(text.slice(0, 4096));
  const commits = [];
  if (mbox) {
    const pattern = /^Subject: (?:\[[^\]]*\] )?(.*(?:\n[ \t].*)*)$/gm;
    for (let match = pattern.exec(text); match; match = pattern.exec(text)) commits.push(match[1].replace(/\n[ \t]+/g, ' ').trim());
  }
  const files = [...new Set([...text.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map(match => match[1]))];
  const plainFiles = files.length ? files : [...new Set([...text.matchAll(/^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/gm)].map(match => match[1]).filter(name => name !== '/dev/null'))];
  return { kind: mbox ? 'mbox' : 'diff', commits, files: plainFiles, patches: mbox ? Math.max(commits.length, 1) : 0, valid: plainFiles.length > 0 };
}

/** `git am --3way` for commits, `git apply [--index]` for a plain diff. */
export function buildApplyArgv({ kind, file, index = false }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('Invalid patch file');
  if (kind === 'mbox') return ['am', '--3way', '--', file];
  if (kind === 'diff') return ['apply', ...(index ? ['--index'] : []), '--', file];
  throw new TypeError('Unknown patch kind');
}

/**
 * Whether the patch would apply to the current files as they are, without
 * changing anything (`git apply --check`). An mbox may still go through
 * `am --3way` when this says no — the three-way fallback is for exactly that.
 */
export async function checkPatch({ cwd, log, file, index = false }) {
  const result = await runGit({ cwd, log, argv: ['apply', '--check', ...(index ? ['--index'] : []), '--', file], operation: 'Read whether the patch applies' });
  return { applies: result.code === 0, reason: result.code === 0 ? null : result.stderr.split('\n').find(line => line.startsWith('error: ')) || 'The patch does not apply to the current files.' };
}

/** @param {{ cwd: string, log: object, kind: 'mbox'|'diff', file: string, index?: boolean }} options */
export async function applyPatch({ cwd, log, kind, file, index = false }) {
  const argv = buildApplyArgv({ kind, file, index });
  const result = await runGit({ cwd, log, argv, operation: kind === 'mbox' ? 'Apply patches as commits (am)' : 'Apply a patch to the files' });
  if (result.code === 0) return { ok: true, message: null };
  return { ok: false, message: kind === 'mbox' ? 'git am stopped. Show output in the console.' : 'The patch did not apply; nothing was changed. Show output in the console.' };
}

export async function readPatchFile(file) {
  const content = await readFile(file);
  if (content.length > MAX_PATCH_BYTES) throw new Error('This file is larger than 50 MB; it is not a patch 🌱 Twig will apply.');
  return content;
}
