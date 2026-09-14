// The manual update check, without touching the network: every request goes
// through an injected fetch, so what is asserted here is the parsing, the
// comparison and what the app does with an answer it cannot trust.
import assert from 'node:assert/strict';
import { RELEASES_API, RELEASES_PAGE, checkForUpdate, compareVersions, interpretRelease, parseVersion } from '../../main/update-check.js';

// Tag forms.
assert.deepEqual(parseVersion('twig-v0.8.3'), [0, 8, 3]);
assert.deepEqual(parseVersion('v1.0.0'), [1, 0, 0]);
assert.deepEqual(parseVersion(' 0.8.3 '), [0, 8, 3]);
for (const bad of ['0.8', '0.8.3-rc1', 'twig-0.8.3.1', 'latest', '', null, undefined, 42, '0.8.3\n1.0.0']) {
  assert.equal(parseVersion(bad), null, `rejects ${JSON.stringify(bad)}`);
}

assert.equal(compareVersions([0, 8, 3], [0, 8, 3]), 0);
assert.equal(compareVersions([0, 8, 3], [0, 9, 0]), -1);
assert.equal(compareVersions([0, 10, 0], [0, 9, 9]), 1);
assert.equal(compareVersions([1, 0, 0], [0, 99, 99]), 1);

// A newer tag is an update; the same or an older one is not.
const page = url => ({ tag_name: 'twig-v0.9.0', html_url: url });
assert.equal(interpretRelease('0.8.3', page('https://github.com/kitarasenka/twig/releases/tag/twig-v0.9.0')).status, 'update');
assert.equal(interpretRelease('0.9.0', { tag_name: 'twig-v0.9.0' }).status, 'current');
assert.equal(interpretRelease('1.0.0', { tag_name: 'twig-v0.9.0' }).status, 'current');
assert.equal(interpretRelease('0.8.3', page('https://github.com/kitarasenka/twig/releases/tag/twig-v0.9.0')).latest, '0.9.0');

// The release body comes off the network: only this repository's own release
// URL is passed through to a link the person can click.
for (const hostile of ['https://evil.example/pwn', 'javascript:alert(1)', 'https://github.com/someone/else/releases/tag/v1', 42, null]) {
  assert.equal(interpretRelease('0.8.3', page(hostile)).url, RELEASES_PAGE, `rewrites ${JSON.stringify(hostile)}`);
}
// An unreadable tag is reported as unknown, never guessed at.
for (const shape of [null, {}, { tag_name: 'nightly' }, { tag_name: 42 }, 'a string']) {
  assert.equal(interpretRelease('0.8.3', shape).status, 'unknown');
}
assert.equal(interpretRelease('not a version', { tag_name: 'twig-v0.9.0' }).status, 'unknown');

// One request, to the releases endpoint, with no credentials attached.
let seen = null;
const ok = body => async (url, options) => {
  seen = { url, options };
  return { ok: true, status: 200, json: async () => body };
};
let result = await checkForUpdate({ currentVersion: '0.8.3', fetchImpl: ok({ tag_name: 'twig-v0.9.0' }) });
assert.equal(result.status, 'update');
assert.equal(seen.url, RELEASES_API);
assert.equal(seen.options.redirect, 'error', 'a redirect is refused rather than followed anywhere');
assert.ok(seen.options.signal, 'the request carries a timeout signal');
assert.deepEqual(Object.keys(seen.options.headers).sort(), ['accept', 'user-agent']);
assert.match(seen.options.headers['user-agent'], /^Twig\/0\.8\.3$/);

// Every failure keeps the link and says what happened, instead of claiming the
// running version is current.
const failures = [
  [async () => { throw new Error('offline'); }, /Could not reach GitHub/],
  [async () => ({ ok: false, status: 404 }), /No published release yet/],
  [async () => ({ ok: false, status: 503 }), /GitHub answered 503/],
  [async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }), /could not read/]
];
for (const [fetchImpl, message] of failures) {
  result = await checkForUpdate({ currentVersion: '0.8.3', fetchImpl });
  assert.equal(result.status, 'error');
  assert.equal(result.latest, null);
  assert.equal(result.url, RELEASES_PAGE);
  assert.match(result.message, message);
}

// The timeout is real: a request that never settles ends as a reachable error.
result = await checkForUpdate({ currentVersion: '0.8.3', timeoutMs: 30, fetchImpl: (url, options) => new Promise((_resolve, reject) => {
  options.signal.addEventListener('abort', () => reject(options.signal.reason));
}) });
assert.equal(result.status, 'error');

console.log('Update check passed: tag parsing, comparison, hostile release URLs, request shape, failures and timeout.');
