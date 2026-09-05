import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { loadCommit, loadCommitFiles, loadFileDiff, loadRangeFiles, validateOid, validateFile, parseChangedFiles } from '../../main/git/commit.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-commit-'));
try {
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async argv => {
    const result = await runGit({ cwd, log, argv });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Test']);
  await git(['config', 'user.email', 'twig@example.invalid']);
  const file = '- odd 🌱 [name].txt';
  await writeFile(path.join(cwd, file), 'first\r\nsecond\r\n');
  await git(['add', '--', file]);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Root subject', '-m', 'Body with Unicode 🌱\nSecond line']);
  const oid = (await git(['rev-parse', 'HEAD'])).trim();
  const rootCommit = await loadCommit({ cwd, log, oid });
  assert.equal(rootCommit.subject, 'Root subject');
  assert.match(rootCommit.body, /Unicode 🌱/);
  assert.deepEqual(rootCommit.parents, []);
  assert.deepEqual(rootCommit.files, [{ status: 'A', path: file }]);
  assert.deepEqual(await loadCommitFiles({ cwd, log, oid }), [{ path: file, status: ' ' }]);
  assert.match((await loadFileDiff({ cwd, log, oid, file })).patch, /\+first/);
  await writeFile(path.join(cwd, file), 'changed\r\nsecond\r\n');
  await git(['add', '--', file]);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Second']);
  const next = (await git(['rev-parse', 'HEAD'])).trim();
  assert.deepEqual((await loadCommit({ cwd, log, oid: next })).parents, [oid]);
  assert.deepEqual(await loadRangeFiles({ cwd, log, base: oid, oid: next }), [{ status: 'M', path: file }]);
  const diff = await loadFileDiff({ cwd, log, base: oid, oid: next, file });
  assert.match(diff.patch, /-first/); assert.match(diff.patch, /\+changed/);
  assert.throws(() => validateOid('--output=/tmp/escape'));
  assert.throws(() => validateFile('../outside'));
  assert.throws(() => validateFile('file\0injection'));
  assert.throws(() => parseChangedFiles('M\0missing delimiter'));
  assert.equal(validateFile(':literal*'), ':literal*');
  console.log('Commit checks passed: root, body, parents, files, literal Unicode paths, CRLF, range diff, validation.');
} finally { await rm(root, { recursive: true, force: true }); }
