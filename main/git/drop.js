import path from 'node:path';
import { runGit } from './exec.js';
import { validateOid } from './commit.js';
import { validateRefName } from './refs-ops.js';
import { loadRefs } from './refs.js';
import { loadRemotes, validateRepositoryUrl } from './remotes.js';
import { exists, loadOperationState, resolveGitDir } from './operation-state.js';
import { parseStatusV2 } from './status-parser.js';
import { buildEditorEnv } from './rebase.js';
import { buildDropPlan, remoteEndpoint } from './drop-plan.js';

export function validateDropRequest(request) {
  if (!request || typeof request !== 'object' || typeof request.action !== 'string' || request.action.length > 32) throw new TypeError('Invalid drop request');
  for (const item of [request.source, request.target]) {
    if (!item || !['local', 'remote', 'commit'].includes(item.kind)) throw new TypeError('Invalid drop endpoint');
    validateOid(item.oid);
    if (item.kind === 'commit') {
      if (item.ref !== null) throw new TypeError('Invalid commit endpoint');
    } else {
      const prefix = item.kind === 'local' ? 'refs/heads/' : 'refs/remotes/';
      if (typeof item.ref !== 'string' || !item.ref.startsWith(prefix)) throw new TypeError('Invalid branch endpoint');
      const name = validateRefName(item.ref.slice(prefix.length));
      if (name.startsWith('-')) throw new TypeError('Invalid branch endpoint');
    }
  }
  if (!request.head || (request.head.branch !== null && typeof request.head.branch !== 'string')) throw new TypeError('Invalid expected HEAD');
  validateOid(request.head.oid);
  if (request.head.branch !== null) validateRefName(request.head.branch);
  if (request.mainline !== null && (!Number.isInteger(request.mainline) || request.mainline < 1 || request.mainline > 16)) throw new TypeError('Invalid mainline parent');
  return request;
}

export async function runDrop({ cwd, log, request, signal = null }) {
  validateDropRequest(request);
  if (signal?.aborted) return { ok: false, cancelled: true, notStarted: true, message: 'Cancelled before Git started.' };
  const gitDir = await resolveGitDir({ cwd, log });
  const options = { cwd, log, gitDir };
  const finish = async result => ({ ...result, state: await loadOperationState(options) });
  const refuse = message => finish({ ok: false, notStarted: true, message });
  const state = await loadOperationState(options);
  if (state.kind !== 'none' || await exists(path.join(gitDir, 'BISECT_START'))) return refuse('Finish or abort the current operation first.');
  const statusResult = await runGit({ cwd, log, argv: ['status', '--porcelain=v2', '--branch', '-z'], operation: 'Background: verify drop destination' });
  if (statusResult.code !== 0) return refuse('Could not verify the working tree.');
  const status = parseStatusV2(statusResult.stdout);
  if (status.branch.oid !== request.head.oid || (status.branch.name || null) !== request.head.branch) return refuse('HEAD changed. Refresh and drag again.');
  if (status.entries.length) return refuse('Commit or stash your changes first.');
  const refs = await loadRefs(options);
  const parents = new Map();
  for (const item of [request.source, request.target]) {
    if (item.kind !== 'commit' && !refs.some(ref => ref.fullName === item.ref && ref.target === item.oid)) return refuse('A dragged branch moved or was deleted. Refresh and drag again.');
    if (!parents.has(item.oid)) {
      const result = await runGit({ cwd, log, argv: ['show', '--no-patch', '--format=%H%x00%P', item.oid, '--'], operation: 'Background: verify dragged commit' });
      const [oid, parentText] = result.stdout.trimEnd().split('\0');
      if (result.code !== 0 || oid !== item.oid || parentText === undefined) return refuse('A dragged commit is unavailable. Refresh and drag again.');
      parents.set(item.oid, parentText ? parentText.split(' ') : []);
    }
  }
  const remotes = request.action.startsWith('pull') || request.action === 'push' ? await loadRemotes(options) : [];
  const remoteNames = remotes.map(item => item.name);
  const plan = buildDropPlan({ ...request, remoteNames });
  if (['cherry-pick', 'revert'].includes(request.action)) {
    const count = parents.get(request.source.oid).length;
    if ((count > 1 && request.mainline === null) || (request.mainline !== null && request.mainline > count)) throw new TypeError('Choose a valid mainline parent');
  } else if (request.mainline !== null) throw new TypeError('Unexpected mainline parent');
  if (plan.network) {
    const remote = remoteEndpoint(request.action === 'push' ? request.target : request.source, remoteNames);
    const configured = remotes.find(item => item.name === remote.remote);
    for (const url of [...configured.urls, ...configured.pushUrls]) validateRepositoryUrl(url);
  }
  let started = false;
  for (const argv of plan.commands) {
    if (signal?.aborted) return finish({ ok: false, cancelled: true, notStarted: !started, message: 'Cancelled. Any completed branch switch is kept.' });
    if (argv[0] !== 'switch' && request.action !== 'push') {
      const destination = request.action === 'rebase' ? request.source : request.target;
      const expectedBranch = destination.kind === 'local' ? destination.ref.slice('refs/heads/'.length) : null;
      const result = await runGit({ cwd, log, argv: ['status', '--porcelain=v2', '--branch', '-z'], operation: 'Background: verify selected branch before applying' });
      const current = result.code === 0 ? parseStatusV2(result.stdout) : null;
      if (!current || current.branch.oid !== destination.oid || current.branch.name !== expectedBranch || current.entries.length) {
        return finish({ ok: false, notStarted: !started, message: 'The destination or working tree changed. Refresh and drag again. Any completed branch switch is kept.' });
      }
    }
    started = true;
    const result = await runGit({ cwd, log, argv, signal, env: buildEditorEnv({ gitDir }), operation: `Drag and drop: ${request.action}` });
    if (result.code !== 0 || result.cancelled) return finish({ ok: false, cancelled: result.cancelled, message: result.cancelled ? 'Cancelled. Any completed branch switch is kept.' : 'The operation did not finish. Show output in the console.' });
  }
  return finish({ ok: true, message: null });
}
