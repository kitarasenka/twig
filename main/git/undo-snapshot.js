import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { parseStatusV2 } from './status-parser.js';
import { loadOperationState } from './operation-state.js';

export async function captureState({ cwd, log }) {
  const read = async argv => {
    const result = await runGit({ cwd, log, argv, operation: 'Background: Undo safety check' });
    if (result.code !== 0) throw new Error('Could not verify the repository for Undo.');
    return result.stdout;
  };
  const [raw, refs, index, stash, operation] = await Promise.all([
    read(['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']),
    read(['for-each-ref', '--format=%(refname)%00%(objectname)']),
    read(['ls-files', '--stage', '-z']), read(['stash', 'list', '--format=%H%x00%gs', '-z']),
    loadOperationState({ cwd, log })
  ]);
  const status = parseStatusV2(raw);
  // Remote-tracking refs are left out: no inverse reads or moves them, and a
  // fetch — the background one included — would otherwise end the Undo chain
  // for work it never touched.
  // For the same reason the status header's ahead/behind count (`# branch.ab`),
  // which is measured against the remote-tracking branch, is left out too.
  const own = refs.split('\n').filter(line => !line.startsWith('refs/remotes/')).join('\n');
  const tokens = raw.split('\0');
  let headers = 0;
  while (headers < tokens.length && tokens[headers].startsWith('# ')) headers++;
  const local = tokens.filter((token, index) => index >= headers || !token.startsWith('# branch.ab ')).join('\0');
  const hash = createHash('sha256').update(local).update(own).update(index).update(stash).update(operation.kind);
  const root = await realpath(cwd);
  for (const entry of status.entries) {
    const file = path.resolve(root, entry.path);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Cannot verify this working-tree path.');
    hash.update(entry.path);
    let info;
    try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') { hash.update('missing'); continue; } throw error; }
    const parent = path.relative(root, await realpath(path.dirname(file)));
    if (parent.startsWith('..') || path.isAbsolute(parent)) throw new Error('Cannot verify files through an external directory link.');
    if (info.isSymbolicLink()) hash.update(await readlink(file));
    else if (info.isFile()) {
      for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) })) hash.update(chunk);
    } else hash.update(`${info.mode}:${info.mtimeMs}:${info.size}`);
  }
  const [stashOid = '', stashMessage = ''] = stash.replace(/\0$/, '').split('\0');
  return { digest: hash.digest('hex'), head: status.branch.oid, branch: status.branch.detached ? null : status.branch.name,
    paths: status.entries.map(entry => entry.path), clean: status.entries.length === 0,
    stashOid, stashMessage, operation: operation.kind };
}
