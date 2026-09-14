// One version, four places. The site reads package.json at build time, but the
// README carries the number as plain text and package-lock.json repeats it
// twice, so nothing but a check keeps them from drifting apart after a release.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = async (name) => JSON.parse(await readFile(new URL(name, root), 'utf8'));

const pkg = await read('package.json');
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json carries a plain semver version');

const lock = await read('package-lock.json');
assert.equal(lock.version, pkg.version, 'package-lock.json version matches package.json');
assert.equal(lock.packages?.['']?.version, pkg.version, 'the lock file root package matches too');

const readme = await readFile(new URL('README.md', root), 'utf8');
const stated = readme.match(/\*\*Current version: (\d+\.\d+\.\d+)\.\*\*/);
assert.ok(stated, 'README states the current version');
assert.equal(stated[1], pkg.version, 'the README version matches package.json');

console.log(`Version check passed: ${pkg.version} in package.json, package-lock.json and README.`);
