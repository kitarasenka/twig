// CHANGELOG.md is the single source of patch notes: the site renders the newest
// section, the release workflow uses it as the body of the GitHub release, and
// scripts/checks/version.mjs refuses a version that has no section of its own.
// No imports: the Pages workflow installs without dev dependencies.

// "14 сентября 2026" — the spelling used in the CHANGELOG heading and on the
// site. Node 20 ships full ICU, so ru-RU month names are available everywhere.
export const formatDate = (iso) => new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(`${iso}T00:00:00Z`)).replace(/\s*г\.$/, '');

// ## <version> — <date>, then "- " lines until the next heading. A note may
// wrap across lines; continuation lines are indented, never prefixed with "- ".
export function parseChangelog(text) {
  const releases = [];
  let current = null;
  for (const line of String(text).split('\n')) {
    const heading = line.match(/^##\s+(\d+\.\d+\.\d+)\s+—\s+(.+?)\s*$/);
    if (heading) {
      current = { version: heading[1], date: heading[2], notes: [] };
      releases.push(current);
      continue;
    }
    if (/^#/.test(line)) { current = null; continue; }
    if (!current) continue;
    const item = line.match(/^-\s+(.*)$/);
    if (item) { current.notes.push(item[1].trim()); continue; }
    if (current.notes.length && line.trim()) {
      current.notes[current.notes.length - 1] += ` ${line.trim()}`;
    }
  }
  return releases;
}

export function pickRelease(releases, version) {
  const release = releases.find((entry) => entry.version === version);
  if (!release) throw new Error(`CHANGELOG.md has no section for ${version}`);
  if (!release.notes.length) throw new Error(`CHANGELOG.md section ${version} lists no notes`);
  return release;
}

export const releaseNotes = (text, version) => pickRelease(parseChangelog(text), version);
