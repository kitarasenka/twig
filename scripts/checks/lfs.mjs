import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { loadFileDiff } from '../../main/git/commit.js';
import { findLfsProgram, loadLfsStatus, parseLfsFiles, parseLfsVersion, pullLfs } from '../../main/git/lfs.js';
import { formatSize, lfsChangeLabel, lfsPointerDiff, parseLfsPointer, patchSides } from '../../renderer/src/features/diff/lfs-pointer.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const pointer = (oid, size) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

// --- pointers -------------------------------------------------------------------------------
assert.deepEqual(parseLfsPointer(pointer(A, 1234)), { oid: A, size: 1234 });
assert.deepEqual(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\next-0-foo sha256:${B}\noid sha256:${A}\nsize 5`), { oid: A, size: 5 }, 'extension lines are allowed');
assert.equal(parseLfsPointer('version https://example.com/spec\noid sha256:x\nsize 1\n'), null, 'an unknown spec is ordinary text');
assert.equal(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${A}\n`), null, 'no size, no pointer');
assert.equal(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${A}\nsize 12\nand then some prose\n`), null);
assert.equal(parseLfsPointer('x'.repeat(2000)), null);

const replaced = `diff --git a/big.bin b/big.bin\nindex 1..2 100644\n--- a/big.bin\n+++ b/big.bin\n@@ -1,3 +1,3 @@\n version https://git-lfs.github.com/spec/v1\n-oid sha256:${A}\n-size 1000\n+oid sha256:${B}\n+size 2500000\n`;
assert.deepEqual(patchSides(replaced), { before: pointer(A, 1000).trimEnd(), after: pointer(B, 2500000).trimEnd() });
assert.deepEqual(lfsPointerDiff(replaced), { before: { oid: A, size: 1000 }, after: { oid: B, size: 2500000 } });
assert.equal(lfsChangeLabel(lfsPointerDiff(replaced)), 'Replaced in Git LFS: 1000 B → 2.4 MB');
const added = `diff --git a/n.bin b/n.bin\nnew file mode 100644\n--- /dev/null\n+++ b/n.bin\n@@ -0,0 +1,3 @@\n+version https://git-lfs.github.com/spec/v1\n+oid sha256:${A}\n+size 2048\n`;
assert.equal(lfsChangeLabel(lfsPointerDiff(added)), 'Added 2 KB to Git LFS');
assert.equal(lfsChangeLabel(lfsPointerDiff(added.replaceAll('\n+', '\n-').replace('@@ -0,0 +1,3 @@', '@@ -1,3 +0,0 @@'))), 'Removed 2 KB from Git LFS');
const migrated = `diff --git a/m.bin b/m.bin\n--- a/m.bin\n+++ b/m.bin\n@@ -1 +1,3 @@\n-plain text that was here\n+version https://git-lfs.github.com/spec/v1\n+oid sha256:${A}\n+size 9\n`;
assert.equal(lfsPointerDiff(migrated), null, 'a file moved into LFS still shows its old text: the patch is not only pointers');
assert.equal(lfsPointerDiff('diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n'), null);
assert.equal(formatSize(0), '0 B');
assert.equal(formatSize(1536), '1.5 KB');
assert.equal(formatSize(50 * 1024 * 1024), '50 MB');
assert.equal(formatSize(-1), '');

assert.deepEqual(parseLfsFiles(`${A} * assets/big file.psd\n${B} - video.mp4\n`), [
  { oid: A, present: true, path: 'assets/big file.psd' }, { oid: B, present: false, path: 'video.mp4' }]);
assert.throws(() => parseLfsFiles('abc * short-oid\n'), /Invalid git lfs/);
assert.equal(parseLfsVersion('git-lfs/3.4.1 (GitHub; darwin arm64; go 1.21.5)\n'), '3.4.1');
assert.equal(parseLfsVersion('something else'), null);
for (const label of ['Read whether the repository uses Git LFS', 'Read .gitattributes for Git LFS', 'Read Git LFS version', 'Read Git LFS files']) assert.equal(isUserCommand(label), false, label);
assert.equal(isUserCommand('Download Git LFS files'), true, 'the download is the person’s own action');

// --- real Git, with a stand-in git-lfs on PATH ----------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-lfs-'));
const savedPath = process.env.PATH;
try {
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const cwd = path.join(root, 'repo');
  const git = async argv => { const result = await runGit({ cwd, log, argv }); assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };
  await runGit({ cwd: root, log, argv: ['init', '--initial-branch=main', cwd] });
  for (const [key, value] of [['user.name', 'Twig Check'], ['user.email', 'check@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  await writeFile(path.join(cwd, 'readme.txt'), 'hi\n'); await git(['add', 'readme.txt']); await git(['commit', '-m', 'plain']);

  const plain = await loadLfsStatus({ cwd, log });
  assert.equal(plain.used, false, 'no filter=lfs in .gitattributes: not an LFS repository');
  assert.ok(!log.list().some(entry => entry.argv.includes('lfs')), 'git-lfs is not even asked about in a repository that does not use it');
  assert.ok(log.list().every(entry => entry.code === 0), 'no read exits non-zero: a failed-looking entry would steal "Show output"');
  await writeFile(path.join(cwd, '.gitattributes'), '*.txt text\n'); await git(['add', '.gitattributes']); await git(['commit', '-m', 'attributes without lfs']);
  assert.equal((await loadLfsStatus({ cwd, log })).used, false, '.gitattributes without filter=lfs is not LFS');

  // Commit an LFS-tracked file the way git-lfs would: the pointer is the blob.
  await mkdir(path.join(cwd, 'assets'));
  await writeFile(path.join(cwd, 'assets', '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n');
  await writeFile(path.join(cwd, 'assets', 'art.psd'), pointer(A, 1000));
  await git(['add', '.']); await git(['commit', '-m', 'art in LFS']);
  await writeFile(path.join(cwd, 'assets', 'art.psd'), pointer(B, 2_500_000));
  await git(['commit', '-am', 'new art']);
  const tip = await git(['rev-parse', 'HEAD']);
  const { patch } = await loadFileDiff({ cwd, log, oid: tip, file: 'assets/art.psd' });
  assert.deepEqual(lfsPointerDiff(patch), { before: { oid: A, size: 1000 }, after: { oid: B, size: 2_500_000 } }, 'the real commit diff reads as one stored file replaced');

  const realLfs = (await runGit({ cwd, log, argv: ['lfs', 'version'] })).code === 0;
  if (!realLfs) {
    const before = log.list().length;
    const without = await loadLfsStatus({ cwd, log });
    assert.deepEqual(without, { used: true, installed: false, version: null, files: 0, missing: 0, missingPaths: [] }, 'used, and git-lfs is missing: the banner says so');
    assert.ok(log.list().slice(before).every(entry => entry.code === 0), 'a missing git-lfs is found out without a failing command');
  }

  // A stand-in git-lfs: Git runs `git-lfs` from PATH for `git lfs …`.
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const calls = path.join(root, 'calls.txt');
  await writeFile(path.join(bin, 'git-lfs'), `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  version) echo "git-lfs/3.4.1 (stand-in)";;
  ls-files) if [ -f pulled ]; then echo "${B} * assets/art.psd"; else echo "${B} - assets/art.psd"; fi;;
  pull) if [ -f slow ]; then sleep 5; fi; touch pulled; echo "Downloading LFS objects: 100% (1/1)" >&2;;
  *) exit 2;;
esac
`);
  await chmod(path.join(bin, 'git-lfs'), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${savedPath}`;

  assert.equal(await findLfsProgram({ cwd, log }), path.join(bin, 'git-lfs'));
  assert.equal(await findLfsProgram({ cwd, log, env: { PATH: '' } }), null);
  const pointers = await loadLfsStatus({ cwd, log });
  assert.deepEqual(pointers, { used: true, installed: true, version: '3.4.1', files: 1, missing: 1, missingPaths: ['assets/art.psd'] });
  const pulled = await pullLfs({ cwd, log });
  assert.deepEqual(pulled, { ok: true, cancelled: false, message: null });
  assert.match(await readFile(calls, 'utf8'), /^pull$/m, 'exactly `git lfs pull`, nothing else');
  assert.equal((await loadLfsStatus({ cwd, log })).missing, 0, 'after the download nothing is a pointer');
  assert.ok(log.list().some(entry => entry.operation === 'Download Git LFS files'), 'journaled like every other command');

  await writeFile(path.join(cwd, 'slow'), '');
  const controller = new AbortController();
  const pending = pullLfs({ cwd, log, signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  assert.equal((await pending).cancelled, true, 'the download can be cancelled');
} finally {
  process.env.PATH = savedPath;
  await rm(root, { recursive: true, force: true });
}

console.log('LFS checks passed: pointers recognised in real diffs, sizes in words, not-installed state, pointer count, git lfs pull and its cancel, no LFS probing in other repositories.');
