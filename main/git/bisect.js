import { open } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateOid } from './commit.js';
import { exists, readTrimmed, resolveGitDir } from './operation-state.js';

/**
 * `git bisect` — the search for the commit that introduced a defect.
 *
 * The state is read the same way §6.3 forces every other stopped operation to
 * be read: from the marker files Git documents (`BISECT_START`, `BISECT_TERMS`,
 * `BISECT_EXPECTED_REV`) and from `refs/bisect/*`, never from the English
 * sentence `git bisect` prints. How much is left comes from
 * `git rev-list --bisect-vars`, which is the machine-readable form of that
 * same sentence — it prints `bisect_nr`, `bisect_steps` and `bisect_all` as
 * assignments, and it is what Git's own bisect uses to choose the next commit.
 *
 * `git bisect run` is deliberately absent: it executes an arbitrary command,
 * and this application spawns nothing but `git`.
 */

export const BISECT_MARKS = ['bad', 'good', 'skip'];

const DEFAULT_TERMS = Object.freeze({ bad: 'bad', good: 'good' });
const BISECT_REF = /^refs\/bisect\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * A term reaches argv, so it is validated even though it comes from Git's own
 * `BISECT_TERMS`: a repository is user data, and its files are not a promise.
 */
export function validateTerm(term) {
  if (typeof term !== 'string' || !/^[a-z][a-z0-9-]{0,30}$/.test(term)) throw new TypeError('Invalid bisect term');
  return term;
}

export function buildBisectStartArgv(oid = null) {
  return ['bisect', 'start', ...(oid === null ? [] : [validateOid(oid)])];
}

/** `skip` keeps its name under any terms; `bad`/`good` are spelled with the repository's terms. */
export function buildBisectMarkArgv(mark, terms = DEFAULT_TERMS, oid = null) {
  if (!BISECT_MARKS.includes(mark)) throw new TypeError('Unknown bisect mark');
  const word = mark === 'skip' ? 'skip' : validateTerm(mark === 'bad' ? terms.bad : terms.good);
  return ['bisect', word, ...(oid === null ? [] : [validateOid(oid)])];
}

export const buildBisectResetArgv = () => ['bisect', 'reset'];

export const buildBisectRefsArgv = () => ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/bisect'];

export function buildBisectVarsArgv(badRef, goodRefs) {
  for (const ref of [badRef, ...goodRefs]) if (!BISECT_REF.test(ref)) throw new TypeError('Invalid bisect ref');
  return ['rev-list', '--bisect-vars', badRef, '--not', ...goodRefs];
}

export function parseBisectRefs(output, terms) {
  const refs = { bad: null, goods: [], skipped: [], goodRefs: [], badRef: null };
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [name, oid] = line.split('\0');
    if (!BISECT_REF.test(name) || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(oid)) throw new Error('Unexpected bisect ref');
    const leaf = name.slice('refs/bisect/'.length);
    if (leaf === terms.bad) { refs.bad = oid; refs.badRef = name; }
    else if (leaf.startsWith(`${terms.good}-`)) { refs.goods.push(oid); refs.goodRefs.push(name); }
    else if (leaf.startsWith('skip-')) refs.skipped.push(oid);
  }
  return refs;
}

/**
 * Every answer given so far, from `BISECT_LOG` — the replay script Git itself
 * writes (`git bisect replay` runs it). `refs/bisect/*` alone cannot say this:
 * Git keeps only the newest bad commit there, so earlier `bad` answers would
 * vanish from the graph. Git logs each answer twice in fixed forms: a comment
 * `# <term>: [<full oid>] <subject>` (the only record of the ends given to
 * `git bisect start <bad> <good>…`, whose command line keeps the revisions as
 * typed) and, for later answers, `git bisect <term> <full oid>`. Both are read;
 * the subject and every other line are ignored, and the last answer for a
 * commit wins, as it does for Git.
 * @returns {Map<string, 'bad'|'good'|'skip'>}
 */
export function parseBisectLog(text, terms = DEFAULT_TERMS) {
  const words = new Map([[terms.bad, 'bad'], [terms.good, 'good'], ['skip', 'skip']]);
  const marks = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^git bisect ([a-z][a-z0-9-]*) ([a-f\d]{40}|[a-f\d]{64})$/i.exec(line.trim())
      || /^# ([a-z][a-z0-9-]*): \[([a-f\d]{40}|[a-f\d]{64})\]/i.exec(line);
    if (!match || !words.has(match[1])) continue;
    const oid = match[2].toLowerCase();
    marks.delete(oid);
    marks.set(oid, words.get(match[1]));
  }
  return marks;
}

/** The log is small in practice; past this it is read only this far. */
const LOG_LIMIT = 1024 * 1024;

async function readBisectLog(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(LOG_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, LOG_LIMIT, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { await handle?.close(); }
}

/** `bisect_rev='<sha>'`, `bisect_nr=<n>` … — shell assignments, one per line. */
export function parseBisectVars(output) {
  const vars = {};
  for (const line of output.split('\n')) {
    const match = /^(bisect_[a-z]+)=('?)([^']*)\2$/.exec(line.trim());
    if (match) vars[match[1]] = match[3];
  }
  return vars;
}

const IDLE = Object.freeze({
  active: false, terms: DEFAULT_TERMS, start: null, bad: null, goods: [], skipped: [], marked: [],
  expected: null, remaining: null, steps: null, done: false, firstBad: null
});

export const idleBisectState = () => ({ ...IDLE, terms: { ...DEFAULT_TERMS }, goods: [], skipped: [], marked: [] });

/**
 * @param {{ cwd: string, log: object, gitDir?: ?string }} options
 * @returns {Promise<typeof IDLE>}
 */
export async function loadBisectState({ cwd, log, gitDir = null }) {
  const dir = gitDir || await resolveGitDir({ cwd, log });
  // BISECT_START is the file Git itself tests for; it holds the branch to
  // return to and is empty when the bisect began on a detached HEAD.
  if (!await exists(path.join(dir, 'BISECT_START'))) return idleBisectState();
  const [start, rawTerms, expected, logText] = await Promise.all([
    readTrimmed(path.join(dir, 'BISECT_START')),
    readTrimmed(path.join(dir, 'BISECT_TERMS')),
    readTrimmed(path.join(dir, 'BISECT_EXPECTED_REV')),
    readBisectLog(path.join(dir, 'BISECT_LOG'))
  ]);
  let terms = { ...DEFAULT_TERMS };
  if (rawTerms) {
    const [bad, good] = rawTerms.split('\n').map(line => line.trim());
    try { terms = { bad: validateTerm(bad), good: validateTerm(good) }; } catch { terms = { ...DEFAULT_TERMS }; }
  }
  const state = {
    ...idleBisectState(), active: true, terms, start: start || null,
    expected: expected && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(expected) ? expected : null
  };

  const refs = await runGit({ argv: buildBisectRefsArgv(), cwd, log, operation: 'Background: read bisect marks' });
  if (refs.code !== 0) return state;
  const marks = parseBisectRefs(refs.stdout, terms);
  // Every answer, for the graph: the log keeps their order, so its last word
  // on a commit is the one that counts; the refs fill in whatever the log does
  // not hold (a bisect started with `git bisect start <bad> <good>` names its
  // ends by revision, not by oid).
  const marked = parseBisectLog(logText, terms);
  const fill = (oid, mark) => { if (!marked.has(oid.toLowerCase())) marked.set(oid.toLowerCase(), mark); };
  if (marks.bad) fill(marks.bad, 'bad');
  marks.goods.forEach(oid => fill(oid, 'good'));
  marks.skipped.forEach(oid => fill(oid, 'skip'));
  Object.assign(state, { bad: marks.bad, goods: marks.goods, skipped: marks.skipped,
    marked: [...marked].map(([oid, mark]) => ({ oid, mark })) });
  if (!marks.badRef || marks.goodRefs.length === 0) return state;

  const vars = await runGit({
    argv: buildBisectVarsArgv(marks.badRef, marks.goodRefs), cwd, log,
    operation: 'Background: count remaining bisect steps'
  });
  if (vars.code !== 0) return state;
  const parsed = parseBisectVars(vars.stdout);
  const all = Number(parsed.bisect_all);
  // Only the bad commit itself is left in the range: there is nothing more to
  // test, and that commit is the answer.
  const done = Number.isFinite(all) && all <= 1;
  return {
    ...state,
    remaining: Number.isFinite(Number(parsed.bisect_nr)) ? Number(parsed.bisect_nr) : null,
    steps: Number.isFinite(Number(parsed.bisect_steps)) ? Number(parsed.bisect_steps) : null,
    done, firstBad: done ? marks.bad : null
  };
}

const LABELS = { start: 'Bisect start', reset: 'Bisect reset' };

/**
 * @param {{ cwd: string, log: object, step: string, oid?: ?string, terms?: object }} options
 * @returns {Promise<{ ok: boolean, message: ?string }>}
 */
export async function runBisect({ cwd, log, step, oid = null, terms = DEFAULT_TERMS }) {
  const argv = step === 'start' ? buildBisectStartArgv(oid)
    : step === 'reset' ? buildBisectResetArgv()
      : buildBisectMarkArgv(step, terms, oid);
  const operation = LABELS[step] || `Bisect ${argv[1]}`;
  const result = await runGit({ argv, cwd, log, operation });
  if (result.code !== 0) return { ok: false, message: `${operation} did not finish. Show output in the console.` };
  return { ok: true, message: null };
}
