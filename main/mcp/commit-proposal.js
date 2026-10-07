import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import nodePath from 'node:path';
import { runGit } from '../git/exec.js';
import { loadWorktree } from '../git/worktree.js';
import { parseNumstat } from '../git/numstat.js';
import { loadOperationState } from '../git/operation-state.js';
import { loadRemotes } from '../git/remotes.js';
import { buildPushRefArgv, buildSyncArgv, loadDivergence, pushRef, runSync } from '../git/sync.js';
import { buildStageEverythingArgv, stageEverything } from '../git/stage.js';
import { buildCommitArgv, createCommit, gitReason, validateCommitMessage } from '../git/commit-ops.js';
import { readTagRef, validateRefName } from '../git/refs-ops.js';
import { triggerPipeline } from '../automation/engine.js';
import { pickPreviousTag, tagArgv } from '../../renderer/src/features/automations/release-tag.js';
import { McpError } from './errors.js';
import { fileLine } from './serialize.js';

/** How long one propose_commit or await_commit call waits for the person before answering "pending". */
export const WAIT_MS = 45_000;
/** A proposal nobody decided on, or an outcome nobody collected, is forgotten after this. */
export const PROPOSAL_TTL_MS = 30 * 60_000;
export const MESSAGE_LIMIT = 100_000;

const short = oid => (oid ? oid.slice(0, 12) : null);

/**
 * What a commit of "everything" would take, and a fingerprint of it: HEAD,
 * the branch, every changed path with its status, and each changed file's
 * size, mode and modification time. A file edited again after the agent
 * looked changes its fingerprint even when its status letter does not.
 */
export async function readProposalState({ cwd, log }) {
  const worktree = await loadWorktree({ cwd, log, allUntracked: true });
  const { branch } = worktree;
  const operation = await loadOperationState({ cwd, log });
  const head = branch.oid || null;
  const numstat = await runGit({ cwd, log, operation: 'Read change sizes for a commit proposal',
    argv: ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--numstat', '-z', '--find-renames', ...(head ? ['HEAD'] : ['--cached']), '--'] });
  if (numstat.code !== 0) throw new Error('Git could not count the changed lines.');
  const counts = parseNumstat(numstat.stdout);

  const byPath = new Map();
  for (const file of worktree.staged) byPath.set(file.path, { path: file.path, originalPath: file.originalPath, letter: file.status });
  for (const file of worktree.unstaged) if (!byPath.has(file.path) || file.status === 'U' || file.status === 'D') byPath.set(file.path, { path: file.path, originalPath: file.originalPath, letter: file.status });
  for (const file of worktree.untracked) byPath.set(file.path, { path: file.path, originalPath: null, letter: 'A', untracked: true });
  const files = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(file => {
    const count = counts.get(file.path);
    return { ...file, insertions: count?.insertions ?? null, deletions: count?.deletions ?? null, binary: Boolean(count?.binary) };
  });

  const hash = createHash('sha256');
  hash.update(`${head}\0${branch.name}\0${branch.detached}\0`);
  for (const file of files) {
    hash.update(`${file.path}\0${file.letter}\0`);
    try {
      const info = await lstat(nodePath.join(cwd, file.path), { bigint: true });
      hash.update(`${info.size}\0${info.mode}\0${info.mtimeNs}\0`);
    } catch { hash.update('gone\0'); }
  }
  return {
    head, branch: branch.detached ? null : branch.name, detached: branch.detached, unborn: branch.unborn,
    operation: operation.kind, conflicts: files.filter(file => file.letter === 'U').length,
    files, fingerprint: hash.digest('hex')
  };
}

/**
 * Why this state cannot be committed by an agent at all, or null. A release
 * may start from a clean tree: its commit can be the version bump alone, or
 * there is no commit and only HEAD is tagged.
 */
function refusal(state, kind = 'commit') {
  if (state.operation !== 'none') return ['REPOSITORY_BUSY', `A ${state.operation} is in progress. Finish or abort it in 🌱 Twig first.`];
  if (state.conflicts) return ['REPOSITORY_BUSY', 'There are unresolved conflicts. Resolve them in 🌱 Twig first.'];
  if (state.detached) return ['REPOSITORY_BUSY', 'HEAD is detached. Check out a branch in 🌱 Twig first.'];
  if (!state.files.length && (kind !== 'release' || !state.head)) return ['NOTHING_TO_COMMIT', 'There are no changes to commit.'];
  return null;
}

/**
 * The newest tag reachable from HEAD that carries an X.Y.Z, parsed — the
 * pattern a release tag follows (`twig-v0.16.2` → `twig-v0.16.3`) — or null.
 */
export async function readPreviousTag({ cwd, log, head }) {
  if (!head) return null;
  const result = await runGit({ cwd, log, operation: 'Read the previous release tag',
    argv: ['for-each-ref', '--sort=-creatordate', '--count=200', '--merged=HEAD', '--format=%(refname)', 'refs/tags'] });
  if (result.code !== 0) return null;
  return pickPreviousTag(result.stdout.split('\n').filter(Boolean).map(ref => ref.replace(/^refs\/tags\//, '')));
}

/** Where Commit & Push would push: the upstream, or `origin/<branch>` made the upstream, or nowhere and why. */
async function pushTarget({ cwd, log, branch }) {
  const divergence = await loadDivergence({ cwd, log, branch });
  if (divergence.upstream) {
    // The remote a tag goes to with the branch; a remote name may itself contain a slash.
    const configured = await runGit({ cwd, log, argv: ['config', '--get', `branch.${branch}.remote`], operation: 'Read the upstream remote' });
    const remote = configured.code === 0 && configured.stdout.trim() ? configured.stdout.trim() : divergence.upstream.split('/')[0];
    return { mode: 'push', label: divergence.upstream, remote, argv: buildSyncArgv('push') };
  }
  const remotes = await loadRemotes({ cwd, log });
  if (remotes.some(remote => remote.name === 'origin')) {
    return { mode: 'push-upstream', label: `origin/${branch} (new upstream)`, remote: 'origin', argv: buildSyncArgv('push-upstream', branch) };
  }
  return { mode: null, label: null, remote: null, argv: null, reason: `${branch} has no upstream and there is no remote named origin.` };
}

/** A failed automation step in a line or two an agent can act on. */
function stepReason(steps) {
  const failed = steps.filter(step => step.status === 'failed');
  return failed.map(step => {
    const output = `${step.stderr || ''}\n${step.stdout || ''}`.split('\n').map(line => line.trimEnd()).filter(Boolean).slice(-6).join('\n').slice(-600);
    return `${step.pipeline ? `${step.pipeline} → ` : ''}${step.name}: ${step.detail || 'failed'}${output ? `\n${output}` : ''}`;
  }).join('\n') || 'an automation blocked it';
}

/**
 * Commit proposals from agents. A proposal is shown in the window and nothing
 * happens until the person confirms it there; then it runs the app's own
 * commit path — stage everything, the pre-commit and commit-msg automations,
 * `createCommit`, post-commit — inside one Undo record, and, if asked, the
 * pre-push automations and the app's own push. Each proposal keeps the
 * fingerprint of what the agent was shown; if the tree moved before the
 * person confirmed, the dialog is refreshed and asks again instead of
 * committing something nobody looked at.
 *
 * No Electron here: `present` shows a view (or null to close it) and returns
 * whether a window could show it, so the Node check drives all of this.
 * @param {{ log: object, undo: object, automations: object, runs: object, loginPath?: ?string,
 *   isAllowed: () => boolean, present: (view: ?object) => boolean, onStep?: (step: object) => void,
 *   bump?: ?object, now?: () => number }} options
 */
export function createCommitProposals({ log, undo, automations, runs, loginPath = null, isAllowed, present, onStep = null, bump = null, now = Date.now }) {
  /** @type {Map<string, object>} */
  const proposals = new Map();
  let shown = null;

  function view(proposal, extra = {}) {
    const { state } = proposal;
    const totals = state.files.reduce((sum, file) => ({ insertions: sum.insertions + (file.insertions ?? 0), deletions: sum.deletions + (file.deletions ?? 0) }), { insertions: 0, deletions: 0 });
    return {
      id: proposal.id,
      repository: { id: proposal.repo.id, name: proposal.repo.name, path: proposal.repo.path },
      branch: state.branch, head: short(state.head), unborn: state.unborn,
      files: state.files.map(file => ({ path: file.path, line: fileLine(file) })), totals,
      kind: proposal.kind, message: proposal.message, push: proposal.push,
      pushTarget: proposal.target,
      commands: [buildStageEverythingArgv(), buildCommitArgv()],
      bump: proposal.bumpPlan,
      // What the version and tag switches start from: the package.json
      // version (if any) and the previous release tag (if any).
      versioning: { current: proposal.bumpPlan?.targets[0]?.current ?? null, tag: proposal.previousTag },
      defaults: proposal.defaults,
      status: proposal.status, ...extra
    };
  }

  function settle(proposal, outcome) {
    if (proposal.outcome) return;
    proposal.outcome = outcome;
    proposal.status = 'done';
    proposal.settledAt = now();
    for (const resolve of proposal.waiters.splice(0)) resolve(outcome);
    if (shown === proposal.id) { shown = null; present(null); }
  }

  function sweep() {
    const limit = now() - PROPOSAL_TTL_MS;
    for (const [id, proposal] of proposals) {
      if ((proposal.settledAt ?? proposal.createdAt) < limit) {
        if (!proposal.outcome) settle(proposal, 'expired: nobody confirmed it in 🌱 Twig');
        proposals.delete(id);
      }
    }
  }

  async function prepare(repo, kind) {
    const state = await readProposalState({ cwd: repo.path, log });
    const refused = refusal(state, kind);
    if (refused) throw new McpError(refused[0], refused[1]);
    const target = await pushTarget({ cwd: repo.path, log, branch: state.branch });
    // A "Bump version" automation decides the files and the default; without
    // one the root package.json is still offered, bumping nothing by default.
    const bumpPlan = bump ? (await bump.plan({ repo, files: state.files })) ?? (await bump.packagePlan?.({ repo })) ?? null : null;
    const previousTag = await readPreviousTag({ cwd: repo.path, log, head: state.head });
    return { state, target, bumpPlan, previousTag };
  }

  /** Where the switches start: the agent's suggestion for a release, the automation's choice otherwise. */
  function defaults(kind, prepared, suggested) {
    const versioned = Boolean(prepared.bumpPlan || prepared.previousTag);
    if (kind === 'release') {
      return { bump: versioned ? suggested.bump || 'patch' : 'none', tag: true, tagName: suggested.tag || null };
    }
    return { bump: prepared.bumpPlan?.choice ?? 'none', tag: false, tagName: null };
  }

  return {
    /**
     * Shows a proposal and returns its id. One proposal is on screen at a
     * time; a newer one replaces it and the older one is answered so.
     * A `release` (new_version) starts with the version bump and the tag
     * switched on, and its message may be left to the dialog
     * (`chore(release): <version>`).
     * @param {{ repo: { id: string, name: string, path: string }, message: ?string, push: boolean,
     *   kind?: 'commit' | 'release', bump?: ?string, tag?: ?string }} request
     */
    async propose({ repo, message, push, kind = 'commit', bump: suggestedBump = null, tag: suggestedTag = null }) {
      if (!isAllowed()) throw new McpError('WRITE_DISABLED', 'Agents may not propose commits in this 🌱 Twig.',
        { hint: 'The person can allow it in 🌱 Twig: Settings → AI agents (MCP) → Allow agents to propose commits.' });
      const optional = kind === 'release' && (message === null || message === undefined);
      if (!optional && (typeof message !== 'string' || message.length > MESSAGE_LIMIT || !validateCommitMessage(message).valid)) {
        throw new McpError('INVALID_ARGUMENT', 'message must be a non-empty commit message (subject, blank line, body).');
      }
      if (suggestedTag !== null && suggestedTag !== undefined) {
        try { validateRefName(suggestedTag); } catch { throw new McpError('INVALID_ARGUMENT', `${JSON.stringify(suggestedTag)} is not a valid tag name.`); }
      }
      sweep();
      const prepared = await prepare(repo, kind);
      const proposal = { id: randomUUID(), repo, kind, message: optional ? null : message, push, ...prepared,
        defaults: defaults(kind, prepared, { bump: suggestedBump, tag: suggestedTag ?? null }),
        status: 'pending', waiters: [], outcome: null, createdAt: now(), settledAt: null };
      for (const other of proposals.values()) if (!other.outcome && other.status === 'pending') settle(other, 'superseded: a newer proposal replaced it');
      proposals.set(proposal.id, proposal);
      shown = proposal.id;
      if (!present(view(proposal))) {
        shown = null;
        proposals.delete(proposal.id);
        throw new McpError('CONFIRMATION_UNAVAILABLE', 'The 🌱 Twig window is not open, so nobody can confirm a commit.', { hint: 'Ask the person to open 🌱 Twig, then propose again.' });
      }
      return proposal.id;
    },

    /** The outcome text once decided, or null if the person is still deciding after `ms`. */
    wait(id, ms = WAIT_MS) {
      const proposal = proposals.get(id);
      if (!proposal) throw new McpError('PROPOSAL_NOT_FOUND', `No commit proposal ${JSON.stringify(id)}: it was never made, or it expired.`);
      if (proposal.outcome) return Promise.resolve(proposal.outcome);
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          proposal.waiters.splice(proposal.waiters.indexOf(done), 1);
          resolve(null);
        }, ms);
        const done = outcome => { clearTimeout(timer); resolve(outcome); };
        proposal.waiters.push(done);
      });
    },

    /** The proposal on screen, for a window that (re)loads while one is pending. */
    current() {
      const proposal = shown ? proposals.get(shown) : null;
      return proposal && !proposal.outcome ? view(proposal) : null;
    },

    /**
     * The person's answer from the dialog. `message` is the text in the
     * dialog, edited or not; `bump` the version choice; `tag` the tag to
     * create on the commit (null: none). A tag that cannot be made comes back
     * as `{ invalid }` and the dialog stays open.
     * @returns {Promise<{ stale: object } | { invalid: string } | { outcome: string, ok: boolean }>}
     */
    async decide(id, { action, message, bump: choice = null, tag = null }) {
      const proposal = proposals.get(id);
      if (!proposal || proposal.outcome) throw new Error('This proposal was already answered or has expired.');
      if (action === 'cancel') { settle(proposal, 'cancelled by user'); return { outcome: 'cancelled by user', ok: false }; }
      if (proposal.status === 'running') throw new Error('This proposal is already being committed.');
      if (!isAllowed()) {
        settle(proposal, 'not committed: commits from agents were turned off in 🌱 Twig');
        return { outcome: proposal.outcome, ok: false };
      }
      const bumping = Boolean(proposal.bumpPlan && choice && choice !== 'none');
      const committing = proposal.state.files.length > 0 || bumping;
      if (committing) {
        const check = validateCommitMessage(message);
        if (!check.valid) throw new Error(check.error);
      }
      const cwd = proposal.repo.path;
      if (tag !== null) {
        try { validateRefName(tag); } catch { return { invalid: `${tag} is not a valid tag name.` }; }
        if (await readTagRef({ cwd, log, name: tag })) return { invalid: `The tag ${tag} already exists. Choose another name.` };
      }
      if (!committing && tag === null) return { invalid: 'There is nothing to commit. Choose a version to bump or a tag to create.' };
      const fresh = await readProposalState({ cwd, log });
      if (fresh.fingerprint !== proposal.state.fingerprint) {
        // Show what is there now and ask again; the agent's message may no longer describe it.
        const refused = refusal(fresh, proposal.kind);
        if (refused) { settle(proposal, `not committed: the working tree changed and ${refused[1].charAt(0).toLowerCase()}${refused[1].slice(1)}`); return { outcome: proposal.outcome, ok: false }; }
        Object.assign(proposal, await prepare(proposal.repo, proposal.kind));
        const next = view(proposal, { stale: true, message });
        present(next);
        return { stale: next };
      }
      proposal.status = 'running';
      try {
        const outcome = await run(proposal, { message, wantPush: action === 'commit-push', choice: bumping ? choice : null, committing, tag });
        settle(proposal, outcome.text);
        return { outcome: outcome.text, ok: outcome.ok };
      } catch (error) {
        settle(proposal, `not committed: ${error.message}`);
        return { outcome: proposal.outcome, ok: false };
      }
    },

    /** Turning the permission off answers every open proposal. */
    revokeAll() {
      for (const proposal of proposals.values()) if (!proposal.outcome && proposal.status === 'pending') settle(proposal, 'not committed: commits from agents were turned off in 🌱 Twig');
    }
  };

  async function run(proposal, { message, wantPush, choice, committing, tag }) {
    const { repo } = proposal;
    const cwd = repo.path;
    const pipeline = (event, extra = {}) => triggerPipeline({
      event, repoId: repo.id, cwd, log, automations, runs, loginPath, operation: `Agent commit: ${event}`, onStep, ...extra
    });
    const edited = proposal.message !== null && message !== proposal.message;
    const branch = proposal.state.branch;
    const lines = [];

    if (committing) {
      const committed = await undo.perform(cwd, 'worktree:commit', [], async () => {
        // The index as it was, so a refused commit leaves it exactly so.
        const saved = await runGit({ cwd, log, argv: ['write-tree'], operation: 'Save the index before an agent commit' });
        if (saved.code !== 0) return { ok: false, text: 'not committed: the index has entries Git cannot save (intent-to-add or conflicts). Resolve them in 🌱 Twig.' };
        const tree = saved.stdout.trim();
        const restore = () => runGit({ cwd, log, argv: ['read-tree', tree], operation: 'Restore the index after a refused agent commit' });
        await stageEverything({ cwd, log });
        let bumped = [];
        try {
          const pre = await pipeline('pre-commit');
          if (pre.blocked) { await restore(); return { ok: false, text: `not committed: a pre-commit automation blocked it\n${stepReason(pre.steps)}` }; }
          const check = await pipeline('commit-msg', { message });
          if (check.blocked) { await restore(); return { ok: false, text: `not committed: a commit-msg automation blocked it\n${stepReason(check.steps)}` }; }
          if (bump && choice) bumped = await bump.apply({ repo, choice, plan: proposal.bumpPlan });
          await createCommit({ cwd, log, message });
        } catch (error) {
          if (bumped.length) await bump.revert({ repo, applied: bumped }).catch(() => {});
          await restore();
          return { ok: false, text: `not committed: ${error.message}${error.detail ? `\n${error.detail}` : ''}` };
        }
        const head = await runGit({ cwd, log, argv: ['rev-parse', 'HEAD'], operation: 'Read the agent commit' });
        return { ok: true, oid: head.stdout.trim(), bumped };
      });
      if (!committed.ok) return committed;
      void pipeline('post-commit').catch(() => {});
      lines.push(`committed ${short(committed.oid)} on ${branch}: ${message.split('\n')[0]}${edited ? ' (message edited in 🌱 Twig)' : ''}`);
      for (const item of committed.bumped || []) lines.push(`version ${item.path}: ${item.from} → ${item.to}`);
    }

    if (tag !== null) {
      // Its own Undo record: Undo deletes the tag first, the next Undo takes the commit back.
      const tagged = await undo.perform(cwd, 'refs:create-tag', [], async () => {
        const result = await runGit({ cwd, log, argv: tagArgv(validateRefName(tag)), operation: `Create tag ${tag}` });
        if (result.code !== 0) return { ok: false, reason: gitReason(result) };
        const ref = await readTagRef({ cwd, log, name: tag });
        return { ok: true, oid: ref, undo: ref ? [tag, ref] : null };
      });
      if (!tagged.ok) { lines.push(`not tagged: ${tagged.reason || 'git tag failed'}`); return { ok: false, text: lines.join('\n') }; }
      lines.push(`tagged ${tag} at ${short(tagged.oid)}${committing ? '' : ` on ${branch}`}`);
    }
    if (!wantPush) return { ok: true, text: lines.join('\n') };

    const target = await pushTarget({ cwd, log, branch });
    if (!target.mode) { lines.push(`not pushed: ${target.reason}`); return { ok: false, text: lines.join('\n') }; }
    const gate = await pipeline('pre-push', { remote: target.remote });
    if (gate.blocked) { lines.push(`not pushed: a pre-push automation blocked it\n${stepReason(gate.steps)}`); return { ok: false, text: lines.join('\n') }; }
    const pushed = await undo.perform(cwd, 'sync:run', [target.mode, branch], () => runSync({ cwd, log, mode: target.mode, branch }));
    if (pushed.ok) lines.push(`pushed to ${target.mode === 'push' ? target.label : `origin/${branch}`}`);
    else { lines.push(`push failed: ${pushed.reason || pushed.message}`); return { ok: false, text: lines.join('\n') }; }
    if (tag === null) return { ok: true, text: lines.join('\n') };

    // The tag goes to the remote the branch went to, by its full name.
    let sent;
    try {
      buildPushRefArgv({ remote: target.remote, ref: `refs/tags/${tag}` });
      sent = await undo.perform(cwd, 'sync:push-ref', [], () => pushRef({ cwd, log, remote: target.remote, ref: `refs/tags/${tag}` }));
    } catch (error) { sent = { ok: false, message: error.message }; }
    lines.push(sent.ok ? `pushed tag ${tag} to ${target.remote}` : `tag push failed: ${sent.reason || sent.message}`);
    return { ok: sent.ok, text: lines.join('\n') };
  }
}
