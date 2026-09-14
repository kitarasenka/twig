// Prints the patch notes of one version as the body of its GitHub release.
// Used by .github/workflows/release.yml; run locally to preview:
//   node scripts/release-notes.mjs 0.8.4
import { readFile } from 'node:fs/promises';
import { releaseNotes } from './changelog.mjs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const version = process.argv[2] || pkg.version;
const release = releaseNotes(await readFile(new URL('CHANGELOG.md', root), 'utf8'), version);
process.stdout.write(`### Что нового — ${release.date}\n\n${release.notes.map((note) => `- ${note}`).join('\n')}\n`);
