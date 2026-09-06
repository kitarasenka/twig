import assert from 'node:assert/strict';
import { authorCommitsUrl, commitUrl, forgeLabel, forgeLinks, parseRemote, pickRemoteUrl }
  from '../../renderer/src/features/commit/forge-url.js';

const SHA = 'a'.repeat(40);

// Every remote address shape Git writes resolves to the same forge repo.
for (const url of [
  'git@github.com:octo/repo.git',
  'ssh://git@github.com/octo/repo.git',
  'https://github.com/octo/repo.git',
  'https://github.com/octo/repo',
  'git://github.com/octo/repo.git'
]) {
  assert.deepEqual(parseRemote(url), { forge: 'github', host: 'github.com', repo: 'octo/repo' }, url);
}

// GitLab keeps its nested groups; the commit path carries the `-` segment.
assert.deepEqual(parseRemote('git@gitlab.com:group/sub/repo.git'),
  { forge: 'gitlab', host: 'gitlab.com', repo: 'group/sub/repo' });
assert.equal(commitUrl('git@gitlab.com:group/sub/repo.git', SHA),
  `https://gitlab.com/group/sub/repo/-/commit/${SHA}`);
assert.equal(commitUrl('https://github.com/octo/repo.git', SHA),
  `https://github.com/octo/repo/commit/${SHA}`);
assert.equal(commitUrl('git@bitbucket.org:octo/repo.git', SHA),
  `https://bitbucket.org/octo/repo/commits/${SHA}`);

// Self-hosted GitLab is recognised by the host prefix.
assert.equal(parseRemote('git@gitlab.example.com:team/app.git')?.forge, 'gitlab');

// Nothing to link: local paths, unknown hosts, credential-bearing URLs.
for (const url of [
  '/home/me/repo', 'file:///home/me/repo', 'https://example.com/o/r.git',
  'https://token@github.com/o/r.git', 'https://user:pass@gitlab.com/o/r.git',
  'git@github.com:onlyrepo', 'ssh://git@github.com/o/r/../../etc.git', '', null, 42
]) {
  assert.equal(parseRemote(url), null, String(url));
  assert.equal(commitUrl(url, SHA), null, String(url));
}

// A bad oid never produces a link even with a good remote.
for (const oid of ['', 'xyz', 'g'.repeat(40), SHA + 'a'.repeat(30), null]) {
  assert.equal(commitUrl('git@github.com:octo/repo.git', oid), null, String(oid));
}

// Author commit lists: GitHub and GitLab filter by the raw email; Bitbucket has none.
assert.equal(authorCommitsUrl('git@github.com:octo/repo.git', 'dev@example.com'),
  'https://github.com/octo/repo/commits?author=dev%40example.com');
assert.equal(authorCommitsUrl('https://gitlab.com/g/r.git', 'dev@example.com'),
  'https://gitlab.com/g/r/-/commits?author=dev%40example.com');
assert.equal(authorCommitsUrl('git@bitbucket.org:octo/repo.git', 'dev@example.com'), null);
for (const email of ['', 'not-an-email', 'a@b', null, 'a b@example.com']) {
  assert.equal(authorCommitsUrl('git@github.com:octo/repo.git', email), null, String(email));
}

// pickRemoteUrl prefers origin, then upstream, then any recognised forge, and
// skips remotes that map nowhere.
assert.equal(pickRemoteUrl([
  { name: 'backup', urls: ['/srv/mirror.git'] },
  { name: 'upstream', urls: ['https://github.com/up/stream.git'] },
  { name: 'origin', urls: ['git@gitlab.com:me/fork.git'] }
]), 'git@gitlab.com:me/fork.git');
assert.equal(pickRemoteUrl([{ name: 'origin', urls: ['/only/local'] }]), null);
assert.equal(pickRemoteUrl([]), null);
assert.equal(pickRemoteUrl(null), null);

// forgeLinks is the shape the commit panel consumes.
assert.deepEqual(
  forgeLinks([{ name: 'origin', urls: ['git@github.com:octo/repo.git'] }], { oid: SHA, email: 'dev@example.com' }),
  {
    forge: 'github', host: 'github.com', repo: 'octo/repo',
    commit: `https://github.com/octo/repo/commit/${SHA}`,
    authorCommits: 'https://github.com/octo/repo/commits?author=dev%40example.com'
  }
);
assert.equal(forgeLinks([{ name: 'origin', urls: ['/local/only'] }], { oid: SHA }), null);
assert.equal(forgeLinks([], {}), null);

assert.equal(forgeLabel('github'), 'GitHub');
assert.equal(forgeLabel('gitlab'), 'GitLab');
assert.equal(forgeLabel('whatever'), 'the remote');

// Every built link is one shell.openExternal would accept for a new browser tab.
for (const link of [
  commitUrl('git@github.com:octo/repo.git', SHA),
  authorCommitsUrl('https://gitlab.com/g/r.git', 'dev@example.com')
]) {
  const parsed = new URL(link);
  assert.equal(parsed.protocol, 'https:');
  assert.ok(!parsed.username && !parsed.password, link);
}

console.log('forge-url check passed');
