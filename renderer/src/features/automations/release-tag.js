// The version and tag of a release: which version a commit gets for a bump
// choice, and the tag name that follows the repository's previous tag. Only a
// sibling import — Vite (the commit-proposal dialog), main and the Node check
// all load it. Main checks the final name with validateRefName; this is the
// dialog's quick answer, not the authority.
import { nextVersion } from './version-bump.js';

const TAG_VERSION = /^(.*?)(\d+\.\d+\.\d+)(.*)$/;

/**
 * `twig-v0.16.2` → `{ prefix: 'twig-v', version: '0.16.2', suffix: '' }`, or
 * null for a tag without an X.Y.Z. A pre-release or build suffix (`-rc.1`,
 * `+build`) belongs to that one release and is not carried to the next.
 */
export function parseVersionTag(name) {
  const match = TAG_VERSION.exec(typeof name === 'string' ? name : '');
  if (!match) return null;
  const suffix = /^[-+.]/.test(match[3]) ? '' : match[3];
  return { name, prefix: match[1], version: match[2], suffix };
}

/** The newest tag (names come newest first) that carries a version, parsed, or null. */
export function pickPreviousTag(names) {
  for (const name of names) {
    const parsed = parseVersionTag(name);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The version a commit releases: the package.json version bumped by `choice`
 * (`none` keeps it — the file may already say the new version), or, with no
 * version file, the previous tag's version bumped. null when there is nothing
 * to start from.
 * @param {{ current: ?string, tag: ?{ version: string } }} versioning
 */
export function releaseVersion(versioning, choice) {
  const base = versioning?.current ?? versioning?.tag?.version ?? null;
  if (!base) return null;
  return choice && choice !== 'none' ? nextVersion(base, choice) : base;
}

/** The tag for `version` in the previous tag's pattern (`twig-v0.16.2` → `twig-v0.16.3`), else `v<version>`. */
export function releaseTagName(tag, version) {
  if (!version) return '';
  return tag ? `${tag.prefix}${version}${tag.suffix}` : `v${version}`;
}

/** The message a release commit gets when the agent wrote none. */
export function releaseMessage(version) {
  return version ? `chore(release): ${version}` : 'chore(release)';
}

// git-check-ref-format for one name, as main/git/refs-ops.js enforces it.
const FORBIDDEN = /[\0-\x20\x7f~^:?*[\\]/;

/** Why `name` cannot be a tag, or null. `existing` is a tag the dialog already knows of. */
export function tagNameProblem(name, existing = null) {
  if (typeof name !== 'string' || !name.trim()) return 'Write a tag name';
  if (name.length > 255 || FORBIDDEN.test(name) || name.includes('..') || name.includes('@{') || name === '@'
    || name.startsWith('/') || name.endsWith('/') || name.includes('//') || name.endsWith('.') || name.startsWith('-')
    || name.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'))) {
    return 'Not a valid tag name: no spaces, ~ ^ : ? * [ \\ or ..';
  }
  if (existing && name === existing) return `${name} already exists`;
  return null;
}

/**
 * `git push` of one tag, exactly as main/git/sync.js `buildPushRefArgv`
 * spells it — the dialog prints it before anything runs.
 */
export function tagPushArgv(remote, name) {
  return ['push', '--progress', remote, '--', `refs/tags/${name}`];
}

/** `git tag` of the commit just made, as the dialog prints it and main runs it. */
export function tagArgv(name) {
  return ['tag', '--', name, 'HEAD'];
}
