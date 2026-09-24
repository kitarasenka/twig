/**
 * `Co-authored-by:` trailers — crediting the people a commit was written
 * with, in the form GitHub, GitLab and `git interpret-trailers` all read.
 *
 * One module for both sides, like `drop-plan.js`: main validates each person
 * and builds the `--trailer` argv from here, and the renderer shows the very
 * same trailer line under the message, so what the form promises is what Git
 * writes. No imports — Vite and Node both load this file.
 */

export const CO_AUTHOR_LIMIT = 20;
export const TRAILER_KEY = 'Co-authored-by';

const NAME = /^[^<>\n\r\0]{1,200}$/;
const EMAIL = /^[^\s<>@\0]{1,128}@[^\s<>@\0]{1,125}$/;

/**
 * @param {unknown} value `{ name, email }` from the renderer or from history
 * @returns {{ name: string, email: string }}
 */
export function validateCoAuthor(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || typeof value.email !== 'string') throw new TypeError('Invalid co-author');
  const name = value.name.trim();
  const email = value.email.trim();
  if (!NAME.test(name) || !EMAIL.test(email)) throw new TypeError('Invalid co-author');
  return { name, email };
}

/** The list for one commit: at most CO_AUTHOR_LIMIT people, each e-mail once. */
export function validateCoAuthors(list) {
  if (!Array.isArray(list) || list.length > CO_AUTHOR_LIMIT) throw new TypeError('Invalid co-authors');
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const person = validateCoAuthor(item);
    const key = person.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(person);
  }
  return result;
}

export const coAuthorTrailer = ({ name, email }) => `${TRAILER_KEY}: ${name} <${email}>`;

/**
 * The people whose trailer the message does not carry yet. An amend starts
 * from the old message, trailers included, and Git would repeat a trailer that
 * is not the very last line (`trailer.ifExists` defaults to
 * `addIfDifferentNeighbor`), so the ones already there are left out.
 */
export function missingCoAuthors(message, list) {
  const present = new Set(String(message).split('\n').map(line => line.trim().toLowerCase()));
  return validateCoAuthors(list).filter(person => !present.has(coAuthorTrailer(person).toLowerCase()));
}

/** One argv word per person; the value sits inside the word, so it can never be read as an option. */
export function coAuthorArgv(list) {
  return validateCoAuthors(list).map(person => `--trailer=${coAuthorTrailer(person)}`);
}

/**
 * The people a picker offers for `query`: name or e-mail containing it,
 * nobody already chosen, the most frequent committers first (the order main
 * returns them in).
 * @param {{ name: string, email: string }[]} candidates
 * @param {string} query
 * @param {{ email: string }[]} chosen
 */
export function filterCoAuthors(candidates, query, chosen = [], limit = 8) {
  const taken = new Set(chosen.map(person => person.email.toLowerCase()));
  const needle = String(query || '').trim().toLowerCase();
  const result = [];
  for (const person of candidates || []) {
    if (taken.has(person.email.toLowerCase())) continue;
    if (needle && !person.name.toLowerCase().includes(needle) && !person.email.toLowerCase().includes(needle)) continue;
    result.push(person);
    if (result.length >= limit) break;
  }
  return result;
}
