import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from '../../main/json-file.js';
import { RepositoryStore } from '../../main/store.js';
import { MarksStore } from '../../main/marks-store.js';
import { AutomationsStore } from '../../main/automations-store.js';
import { AutomationRunsStore } from '../../main/automation-runs-store.js';
import { EditorStore } from '../../main/editor-store.js';
import { FetchStore } from '../../main/fetch-store.js';
import { UpdateStore } from '../../main/update-store.js';
import { McpStore } from '../../main/mcp-store.js';
import { UndoService } from '../../main/undo.js';

const root = await mkdtemp(path.join(tmpdir(), 'twig-json-file-'));
try {
  // Missing, valid and broken files.
  const file = path.join(root, 'settings.json');
  assert.equal(await readJsonFile(file), undefined, 'a missing file reads as nothing');
  await writeFileAtomic(file, JSON.stringify({ a: 1 }));
  assert.deepEqual(await readJsonFile(file), { a: 1 });
  assert.deepEqual((await readdir(root)).sort(), ['settings.json'], 'no temporary file is left behind');
  await writeFile(file, '{"a": 1, "b": [');
  assert.equal(await readJsonFile(file), undefined, 'a torn file reads as nothing');
  const aside = (await readdir(root)).filter(name => name.startsWith('settings.json.broken-'));
  assert.equal(aside.length, 1, 'the torn file is kept aside');
  assert.equal(await readFile(path.join(root, aside[0]), 'utf8'), '{"a": 1, "b": [', 'with the person\'s bytes intact');
  assert.equal(await readJsonFile(file), undefined, 'and the next read starts clean');

  // A write cut off before its rename leaves a temporary file; the next load clears it.
  await writeFile(path.join(root, 'settings.json.4242-1.tmp'), '{"half":');
  await writeFile(path.join(root, 'unrelated.json.4242-1.tmp'), 'keep');
  await readJsonFile(file);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), ['unrelated.json.4242-1.tmp'], 'only this file\'s leftovers go');
  await rm(path.join(root, 'unrelated.json.4242-1.tmp'));

  // Two writers at once (two app instances): one complete file wins, never a mix.
  await Promise.all(Array.from({ length: 20 }, (_, index) => writeFileAtomic(file, JSON.stringify({ writer: index, padding: 'x'.repeat(50000) }))));
  assert.equal(typeof (await readJsonFile(file)).writer, 'number');
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.tmp')), []);

  // Every store starts from a torn file instead of failing the launch, and
  // keeps the torn bytes aside.
  const stores = [
    ['repositories.json', dir => new RepositoryStore(dir)], ['marks.json', dir => new MarksStore(dir)],
    ['automations.json', dir => new AutomationsStore(dir)], ['automation-runs.json', dir => new AutomationRunsStore(dir)],
    ['editor.json', dir => new EditorStore(dir)], ['background-fetch.json', dir => new FetchStore(dir)],
    ['updates.json', dir => new UpdateStore(dir)], ['mcp.json', dir => new McpStore(dir)],
    ['operations.json', dir => new UndoService({ directory: dir, log: null })]
  ];
  for (const [name, create] of stores) {
    const dir = await mkdtemp(path.join(root, 'store-'));
    await writeFile(path.join(dir, name), '{"torn": ');
    await create(dir).load();
    const names = await readdir(dir);
    assert.ok(names.some(entry => entry.startsWith(`${name}.broken-`)), `${name}: the torn file is kept aside`);
    assert.ok(!names.includes(name), `${name}: and is not read again`);
  }

  // Connected repositories: only what identifies one goes to disk.
  const dir = await mkdtemp(path.join(root, 'repositories-'));
  const store = new RepositoryStore(dir);
  await store.load();
  const saved = await store.save([{ id: '/r', path: '/r', name: 'r', available: true, status: { branch: { name: 'main' }, entries: [{ path: 'secret-plan.txt' }] } }], '/r');
  assert.equal(saved.repositories[0].status.branch.name, 'main', 'the status stays in memory');
  const onDisk = JSON.parse(await readFile(path.join(dir, 'repositories.json'), 'utf8'));
  assert.deepEqual(onDisk.repositories, [{ id: '/r', path: '/r', name: 'r' }], 'but not on disk');

  // No store reads its file with a bare JSON.parse any more.
  for (const source of ['store.js', 'marks-store.js', 'automations-store.js', 'automation-runs-store.js', 'editor-store.js', 'fetch-store.js', 'update-store.js', 'mcp-store.js', 'undo.js']) {
    const text = await readFile(new URL(`../../main/${source}`, import.meta.url), 'utf8');
    assert.ok(text.includes('readJsonFile') && text.includes('writeFileAtomic'), `${source} uses the shared JSON file helpers`);
    assert.ok(!/JSON\.parse\(await readFile/.test(text), `${source} has no bare JSON.parse of its file`);
  }
  console.log('JSON file checks passed: torn files kept aside and never fatal, stale temporaries cleared, atomic flushed writes, concurrent writers, no status on disk.');
} finally {
  await rm(root, { recursive: true, force: true });
}
