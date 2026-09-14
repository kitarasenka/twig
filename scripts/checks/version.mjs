// One version, four places. The site reads package.json at build time, but the
// README carries the number as plain text and package-lock.json repeats it
// twice, so nothing but a check keeps them from drifting apart after a release.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { formatDate, parseChangelog } from '../changelog.mjs';

const root = new URL('../../', import.meta.url);
const read = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

const pkg = await read('package.json');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json carries a plain semver version');

assert.match(pkg.releaseDate, /^\d{4}-\d{2}-\d{2}$/, 'package.json carries the release date of that version');
assert.ok(!Number.isNaN(Date.parse(`${pkg.releaseDate}T00:00:00Z`)), 'the release date is a real calendar date');

const lock = await read('package-lock.json');
assert.equal(lock.version, pkg.version, 'package-lock.json version matches package.json');
assert.equal(lock.packages?.['']?.version, pkg.version, 'the lock file root package matches too');

const readme = await readFile(new URL('README.md', root), 'utf8');
const stated = readme.match(/\*\*Current version: (\d+\.\d+\.\d+)\.\*\*/);
assert.ok(stated, 'README states the current version');
assert.equal(stated[1], pkg.version, 'the README version matches package.json');

// A release with no patch notes is a release nobody can read: the site section
// and the GitHub release body both come from this section.
const releases = parseChangelog(await readFile(new URL('CHANGELOG.md', root), 'utf8'));
assert.ok(releases.length, 'CHANGELOG.md lists at least one release');
assert.equal(releases[0].version, pkg.version, 'the newest CHANGELOG section is the current version');
assert.equal(releases[0].date, formatDate(pkg.releaseDate), 'that section is dated like package.json releaseDate');
assert.ok(releases[0].notes.length, 'that section lists what appeared in this version');
assert.deepEqual(
  [...new Set(releases.map((entry) => entry.version))],
  releases.map((entry) => entry.version),
  'no version appears twice in CHANGELOG.md',
);

console.log(`Version check passed: ${pkg.version} (released ${pkg.releaseDate}, ${releases[0].notes.length} patch notes) in package.json, package-lock.json, README and CHANGELOG.`);
