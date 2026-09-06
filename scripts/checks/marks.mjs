import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MARK_COLORS, NOTE_LIMIT, validateMark, validateOid } from '../../main/marks.js';
import { MarksStore } from '../../main/marks-store.js';
import { MARK_COLORS as UI_MARK_COLORS } from '../../renderer/src/features/graph/mark-color.js';

// The renderer palette and the main allow-list must never drift apart.
assert.deepEqual([...MARK_COLORS], UI_MARK_COLORS);
assert.deepEqual([...MARK_COLORS].sort(), [...new Set(MARK_COLORS)].sort());

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(64);

// validateMark normalises or rejects — an invalid call is refused, not answered.
assert.deepEqual(validateMark(OID_A.toUpperCase(), 'red', 'note'), { oid: OID_A, color: 'red', note: 'note' });
assert.deepEqual(validateMark(OID_B, 'slate', ''), { oid: OID_B, color: 'slate', note: '' });
assert.deepEqual(validateMark(OID_A, 'green', 'line one\nline two'), { oid: OID_A, color: 'green', note: 'line one\nline two' });
for (const color of [undefined, null, 'crimson', 'RED', 1]) assert.throws(() => validateMark(OID_A, color, ''), TypeError, String(color));
for (const oid of ['abc', 'z'.repeat(40), `${'a'.repeat(38)}..`, OID_A + 'a', 42, null]) assert.throws(() => validateMark(oid, 'red', ''), TypeError, String(oid));
for (const note of ['x'.repeat(NOTE_LIMIT + 1), 'has\0null', 42, null]) assert.throws(() => validateMark(OID_A, 'red', note), TypeError);
assert.doesNotThrow(() => validateMark(OID_A, 'red', 'x'.repeat(NOTE_LIMIT)));
assert.equal(validateOid(OID_A.toUpperCase()), OID_A);
assert.throws(() => validateOid('nope'), TypeError);

const dir = await mkdtemp(path.join(os.tmpdir(), 'twig-marks-'));
try {
  const store = new MarksStore(dir);
  await store.load();
  assert.deepEqual(store.list('/repo/a'), {});

  let map = await store.set('/repo/a', OID_A, { color: 'red', note: 'first' });
  assert.equal(map[OID_A].color, 'red');
  assert.equal(map[OID_A].note, 'first');
  assert.ok(Date.parse(map[OID_A].updatedAt) > 0);

  // Concurrent writes serialise instead of clobbering the file.
  const [after1, after2] = await Promise.all([
    store.set('/repo/a', OID_B, { color: 'blue', note: '' }),
    store.set('/repo/b', OID_A, { color: 'green', note: 'other repo' })
  ]);
  assert.deepEqual(Object.keys(after1).sort(), [OID_A, OID_B].sort());
  assert.deepEqual(Object.keys(after2), [OID_A]);
  assert.deepEqual(Object.keys(store.list('/repo/b')), [OID_A]);

  // Persisted and readable by a fresh store; no temp file left behind.
  const reopened = new MarksStore(dir);
  await reopened.load();
  assert.equal(reopened.list('/repo/a')[OID_A].note, 'first');
  await assert.rejects(readFile(path.join(dir, 'marks.json.next')), { code: 'ENOENT' });

  // Removing the last mark of a repository drops the repository key entirely.
  await store.clear('/repo/b', OID_A);
  assert.deepEqual(store.list('/repo/b'), {});
  const onDisk = JSON.parse(await readFile(path.join(dir, 'marks.json'), 'utf8'));
  assert.equal('/repo/b' in onDisk, false);
  assert.deepEqual(Object.keys(onDisk['/repo/a']).sort(), [OID_A, OID_B].sort());
} finally { await rm(dir, { recursive: true, force: true }); }

console.log('Marks checks passed: colour parity, validation, atomic per-repository store.');
