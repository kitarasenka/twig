// The "Bump version" automation action: which package.json files a commit
// bumps, the next version for each choice, and the text edit itself. No
// imports — Vite (the editor and the commit panel), main and the Node check
// all load it. The edit is textual: only the characters of the version string
// change, so the file's own formatting, key order and line endings stay.

export const BUMP_CHOICES = ['none', 'patch', 'minor', 'major'];
export const BUMP_TARGETS = ['file', 'modules'];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `1.2.3` → `1.2.4` / `1.3.0` / `2.0.0`; null for 'none' or a version that is not plain X.Y.Z. */
export function nextVersion(version, choice) {
  const match = SEMVER.exec(version ?? '');
  if (!match || !['patch', 'minor', 'major'].includes(choice)) return null;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (choice === 'major') return `${major + 1}.0.0`;
  if (choice === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** All three next versions, for showing "current → new" next to each choice. */
export function nextVersions(version) {
  return { patch: nextVersion(version, 'patch'), minor: nextVersion(version, 'minor'), major: nextVersion(version, 'major') };
}

/**
 * Where the string value at `keyPath` sits in a JSON text: `{ start, end,
 * value }` with start/end around the quotes' contents, or null. A small
 * scanner, not JSON.parse: it has to hand back positions. Keys are matched at
 * their own depth only, so `"version"` inside `dependencies` is never taken
 * for the package's own.
 * @param {string} text
 * @param {string[]} keyPath e.g. ['version'] or ['packages', '', 'version']
 */
export function findStringValue(text, keyPath) {
  let i = 0;
  const space = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const string = () => {
    const start = ++i;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) throw new Error('unterminated string');
    const raw = text.slice(start, i);
    i++;
    return { start, end: i - 1, value: JSON.parse(`"${raw}"`) };
  };
  // Skips any value; for objects on the path, descends instead.
  function value(path) {
    space();
    const char = text[i];
    if (char === '"') { const found = string(); return path.length === 0 ? found : null; }
    if (char === '{') {
      i++;
      let found = null;
      for (;;) {
        space();
        if (text[i] === '}') { i++; return found; }
        if (text[i] !== '"') throw new Error('expected a key');
        const key = string().value;
        space();
        if (text[i] !== ':') throw new Error('expected :');
        i++;
        const hit = value(path.length && key === path[0] ? path.slice(1) : [null]);
        if (hit && path.length && key === path[0] && !found) found = hit;
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return found; }
        throw new Error('expected , or }');
      }
    }
    if (char === '[') {
      i++;
      for (;;) {
        space();
        if (text[i] === ']') { i++; return null; }
        value([null]);
        space();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return null; }
        throw new Error('expected , or ]');
      }
    }
    const literal = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!literal) throw new Error('unexpected token');
    i += literal[0].length;
    return null;
  }
  try {
    const found = value(keyPath);
    space();
    if (i !== text.length) return null;
    return found && found.value !== undefined && typeof found.value === 'string' ? found : null;
  } catch { return null; }
}

/** `text` with the string at `keyPath` changed from `from` to `to`, or null if it is not exactly `from` there. */
export function replaceStringValue(text, keyPath, from, to) {
  const found = findStringValue(text, keyPath);
  if (!found || found.value !== from) return null;
  return text.slice(0, found.start) + to + text.slice(found.end);
}

/** The two places package-lock.json repeats the root package's version. */
export const LOCK_PATHS = [['version'], ['packages', '', 'version']];

/**
 * package.json files a bump action touches for a commit of `changedPaths`:
 * its one file, or — for `modules` — `modules/<dir>/package.json` of every
 * module that has a change.
 */
export function bumpTargets(action, changedPaths) {
  if (action.target === 'modules') {
    const dirs = new Set();
    for (const file of changedPaths) {
      const match = /^modules\/([^/]+)\//.exec(file);
      if (match) dirs.add(match[1]);
    }
    return [...dirs].sort().map(dir => `modules/${dir}/package.json`);
  }
  return [action.path || 'package.json'];
}

/** A package.json path an action may name: inside the repository, ending in package.json. */
export function validBumpPath(file) {
  return typeof file === 'string' && /(?:^|\/)package\.json$/.test(file) && !file.startsWith('/') && !file.includes('\\')
    && !file.split('/').some(part => part === '..' || part === '');
}

/** `Patch — package.json 1.2.3 → 1.2.4`, or `Don’t bump the version`, for a choice of a plan. */
export function bumpLabel(plan, choice) {
  if (choice === 'none') return 'Don’t bump the version';
  const name = { patch: 'Patch', minor: 'Minor', major: 'Major' }[choice];
  return `${name} — ${plan.targets.map(target => `${target.path} ${target.current} → ${target.next[choice]}`).join(', ')}`;
}
