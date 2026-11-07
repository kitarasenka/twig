import { createHash, randomUUID } from 'node:crypto';
import { ui } from '../../renderer/src/i18n/i18n.js';
import { runGit } from '../git/exec.js';
import { loadWorktree } from '../git/worktree.js';
import { parseNumstat } from '../git/numstat.js';
import { loadOperationState } from '../git/operation-state.js';
import { readPushPlan } from '../git/push-plan.js';
import { buildPushRefArgv, pushRef, runSync } from '../git/sync.js';
import { buildStageEverythingArgv, stageEverything, withEverythingStaged } from '../git/stage.js';
import { buildCommitArgv, createCommit, gitReason, validateCommitMessage } from '../git/commit-ops.js';
import { inspectRepository, repoTrustDigest } from '../git/config-risk.js';
import { readTagRef, validateRefName } from '../git/refs-ops.js';
import { stepReason, triggerPipeline } from '../automation/engine.js';
import { pickPreviousTag, tagArgv } from '../../renderer/src/features/automations/release-tag.js';
import { McpError } from './errors.js';
import { DIFF_BUDGET, fileLine } from './serialize.js';
import { FILE_LINE_LIMIT } from './file-patches.js';

/** How long one propose_commit or await_commit call waits for the person before answering "pending". */
export const WAIT_MS = 45_000;
/** A proposal nobody decided on, or an outcome nobody collected, is forgotten after this. */
export const PROPOSAL_TTL_MS = 30 * 60_000;
export const MESSAGE_LIMIT = 100_000;
/** One agent's proposals for one folder, at most this often: each brings a dialog up in front of the person. */
export const MIN_PROPOSAL_INTERVAL_MS = 5000;

const short = oid => (oid ? oid.slice(0, 12) : null);

/** `--name-status -z` with renames on: `M\0path\0`, and `R100\0old\0new\0` for a pair. */
function parseNameStatus(output) {
  const tokens = output.split('\0').filter(Boolean);
  const files = [];
  for (let at = 0; at < tokens.length; at++) {
    const letter = tokens[at][0];
    if ('RC'.includes(letter)) { files.push({ letter, originalPath: tokens[at + 1], path: tokens[at + 2] }); at += 2; }
    else { files.push({ letter, originalPath: null, path: tokens[at + 1] }); at += 1; }
  }
  return files;
}

/**
 * What a commit of "everything" would take, and a fingerprint of it: HEAD, the
 * branch and the tree itself, built by `git add --all` in a throwaway index.
 * The tree is the content, so a file swapped for another of the same length
 * with its time put back still changes it. The file list and its line counts
 * compare that same tree with HEAD: new files count, and nothing can go into
 * the commit that the list does not show.
 */
export async function readProposalState({ cwd, log }) {
  const worktree = await loadWorktree({ cwd, log, allUntracked: true });
  const { branch } = worktree;
  const operation = await loadOperationState({ cwd, log });
  const head = branch.oid || null;
  const { tree, changes, counts } = await withEverythingStaged({ cwd, log }, async env => {
    const compare = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--ignore-submodules=none', '-z'];
    const against = [...(head ? ['HEAD'] : []), '--'];
    const written = await runGit({ cwd, log, env, argv: ['write-tree'], operation: 'Read the tree of a commit proposal' });
    const names = await runGit({ cwd, log, env, argv: [...compare, '--name-status', ...against], operation: 'Read the files of a commit proposal' });
    const numstat = await runGit({ cwd, log, env, argv: [...compare, '--numstat', ...against], operation: 'Read change sizes for a commit proposal' });
    if (written.code !== 0 || names.code !== 0 || numstat.code !== 0) throw new Error(ui`Git could not count the changed lines.`);
    return { tree: written.stdout.trim(), changes: parseNameStatus(names.stdout), counts: parseNumstat(numstat.stdout) };
  });
  const files = changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map(file => {
    const count = counts.get(file.path);
    return { ...file, insertions: count?.insertions ?? null, deletions: count?.deletions ?? null, binary: Boolean(count?.binary) };
  });

  const hash = createHash('sha256');
  hash.update(`${head}\0${branch.name}\0${branch.detached}\0${tree}\0`);
  return {
    head, branch: branch.detached ? null : branch.name, detached: branch.detached, unborn: branch.unborn,
    operation: operation.kind, conflicts: [...worktree.staged, ...worktree.unstaged].filter(file => file.status === 'U').length,
    files, tree, fingerprint: hash.digest('hex'), settings: await repoTrustDigest(cwd, log)
  };
}

/**
 * What the commit turned out to be against what was confirmed. A Git hook runs
 * inside `git commit`, past every check before it, so this is read after: the
 * paths a hook added or changed, and whether it rewrote the message.
 */
async function commitDrift({ cwd, log, expected, message }) {
  const read = (argv, extra = {}) => runGit({ cwd, log, argv, operation: 'Read what the agent commit became', ...extra });
  const tree = (await read(['rev-parse', 'HEAD^{tree}'])).stdout.trim();
  const paths = tree === expected ? [] : (await read(['diff', '--name-only', '-z', '--no-renames', expected, tree])).stdout.split('\0').filter(Boolean);
  const written = await read(['stripspace', '--strip-comments'], { stdin: message });
  const committed = await read(['log', '-1', '--format=%B']);
  return { paths, tree: tree !== expected, message: written.code === 0 && written.stdout.trim() !== committed.stdout.trim() };
}

/** What the replacing proposal brings that the one on screen did not, for the note above it. */
function replacedBy(before, after) {
  const known = new Map(before.state.files.map(file => [file.path, fileLine(file)]));
  const paths = after.state.files.filter(file => known.get(file.path) !== fileLine(file)).map(file => file.path);
  return { paths: paths.slice(0, 5), more: Math.max(0, paths.length - 5), push: Boolean(after.push && !before.push), message: after.message !== before.message };
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

/** The repository's own Git hooks a commit or its push runs, by name: the dialog says which. */
const COMMIT_HOOKS = new Set(['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction', 'post-rewrite']);
async function commitHooks({ cwd, log }) {
  const inspected = await inspectRepository(cwd, log, { nested: false });
  return (inspected?.findings ?? []).filter(item => item.kind === 'hook').map(item => item.key.replace(/^hooks\//, '')).filter(name => COMMIT_HOOKS.has(name)).sort();
}

/** Where Commit & Push would push, word for word as it will run, or nowhere and why. */
const pushTarget = ({ cwd, log, branch }) => readPushPlan({ cwd, log, branch, exact: true });

/**
 * Commit proposals from agents. A proposal is shown in the window and nothing
 * happens until the person confirms it there; then it runs the app's own
 * commit path — stage everything, the pre-commit and commit-msg automations,
 * `createCommit`, post-commit — inside one Undo record, and, if asked, the
 * pre-push automations and the app's own push. Each proposal keeps the tree
 * and the push plan the person is shown; if either moved before the person
 * confirmed, or while the automations ran, the dialog is refreshed and asks
 * again instead of committing or pushing something nobody looked at. A Git hook
 * that changes the commit is told to both sides, and the push does not go.
 *
 * No Electron here: `present` shows a view (or null to close it) and returns
 * whether a window could show it, so the Node check drives all of this.
 * @param {{ log: object, undo: object, automations: object, runs: object, loginPath?: ?string,
 *   isAllowed: () => boolean, present: (view: ?object, options?: { focus?: boolean }) => boolean, onStep?: (step: object) => void,
 *   bump?: ?object, now?: () => number, minIntervalMs?: number }} options
 */
export function createCommitProposals({ log, undo, automations, runs, loginPath = null, isAllowed, present, onStep = null, bump = null, now = Date.now, minIntervalMs = MIN_PROPOSAL_INTERVAL_MS }) {
  /** @type {Map<string, object>} */
  const proposals = new Map();
  /** When each folder last proposed. */
  const lastProposed = new Map();
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
      hooks: proposal.hooks ?? [],
      commands: [buildStageEverythingArgv(), buildCommitArgv()],
      bump: proposal.bumpPlan,
      // What the version and tag switches start from: the package.json
      // version (if any) and the previous release tag (if any).
      versioning: { current: proposal.bumpPlan?.targets[0]?.current ?? null, tag: proposal.previousTag },
      defaults: proposal.defaults,
      // Proposals from other worktrees, waiting for this one to be answered.
      waiting: open().filter(other => other.id !== proposal.id).length,
      // What replaced the proposal the person was reading: the dialog says so and holds its buttons.
      replaced: proposal.replaced ?? null,
      status: proposal.status, ...extra
    };
  }

  /** The tree or the push moved: show what is there now and ask again; the agent's message may no longer describe it. */
  async function refresh(proposal, why, message) {
    const fresh = await readProposalState({ cwd: proposal.repo.path, log });
    const refused = refusal(fresh, proposal.kind);
    if (refused) { settle(proposal, `not committed: the working tree changed and ${refused[1].charAt(0).toLowerCase()}${refused[1].slice(1)}`); return { outcome: proposal.outcome, ok: false }; }
    Object.assign(proposal, await prepare(proposal.repo, proposal.kind), { status: 'pending', replaced: null });
    const next = view(proposal, { stale: true, staleWhy: why, message });
    present(next);
    return { stale: next };
  }

  /** Proposals nobody has answered yet, oldest first. */
  function open() {
    return [...proposals.values()].filter(proposal => !proposal.outcome).sort((a, b) => a.createdAt - b.createdAt);
  }

  function settle(proposal, outcome) {
    if (proposal.outcome) return;
    proposal.outcome = outcome;
    proposal.status = 'done';
    proposal.settledAt = now();
    for (const resolve of proposal.waiters.splice(0)) resolve(outcome);
    if (shown !== proposal.id) return;
    // The next one in line, from another worktree, takes the dialog.
    const next = open()[0] ?? null;
    shown = next?.id ?? null;
    present(next ? view(next) : null);
  }

  function sweep() {
    const limit = now() - PROPOSAL_TTL_MS;
    for (const [id, proposal] of proposals) {
      if ((proposal.settledAt ?? proposal.createdAt) < limit) {
        if (!proposal.outcome) settle(proposal, ui`expired: nobody confirmed it in 🌱 Twig`);
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
    // A worktree nobody connected follows the automations of its repository.
    const automationRepo = repo.worktreeOf ? { ...repo, id: repo.worktreeOf } : repo;
    const bumpPlan = bump ? (await bump.plan({ repo: automationRepo, files: state.files })) ?? (await bump.packagePlan?.({ repo })) ?? null : null;
    const previousTag = await readPreviousTag({ cwd: repo.path, log, head: state.head });
    return { state, target, bumpPlan, previousTag, hooks: await commitHooks({ cwd: repo.path, log }) };
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
     * time. A newer one from the same worktree replaces the older one, which
     * is answered so; one from another worktree — another agent working in
     * parallel — waits in line and is shown when the one on screen is answered.
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
      const wait = (lastProposed.get(repo.path) ?? -Infinity) + minIntervalMs - now();
      if (wait > 0) {
        throw new McpError('RATE_LIMITED', `Too many proposals from this folder. Propose again in ${Math.ceil(wait / 1000)} s.`,
          { hint: 'The person sees one dialog at a time: wait for their answer with await_commit instead of proposing again.' });
      }
      lastProposed.set(repo.path, now());
      sweep();
      const prepared = await prepare(repo, kind);
      const proposal = { id: randomUUID(), repo, kind, message: optional ? null : message, push, ...prepared,
        defaults: defaults(kind, prepared, { bump: suggestedBump, tag: suggestedTag ?? null }),
        status: 'pending', waiters: [], outcome: null, createdAt: now(), settledAt: null };
      const same = other => other.repo.path === repo.path;
      // Settled before this one is added, so the dialog does not move on to a proposal it replaces.
      const replaced = open().filter(other => same(other) && other.status === 'pending');
      proposals.set(proposal.id, proposal);
      const onScreen = shown ? proposals.get(shown) : null;
      const dialogUp = Boolean(onScreen && !onScreen.outcome);
      const queued = dialogUp && !replaced.includes(onScreen);
      // A proposal swapped under someone reading it has to say so.
      if (onScreen && replaced.includes(onScreen)) proposal.replaced = replacedBy(onScreen, proposal);
      // Set first: a replaced proposal on screen then hands the dialog to this one, not to the next in line.
      if (!queued) shown = proposal.id;
      for (const other of replaced) settle(other, 'superseded: a newer proposal replaced it');
      // Shown, or the one on screen shown again with one more waiting. Only a
      // dialog that was not there takes the window from what the person is doing.
      if (!present(view(queued ? onScreen : proposal), { focus: !dialogUp })) {
        if (shown === proposal.id) shown = null;
        proposals.delete(proposal.id);
        throw new McpError('CONFIRMATION_UNAVAILABLE', 'The 🌱 Twig window is not open, so nobody can confirm a commit.', { hint: 'Ask the person to open 🌱 Twig, then propose again.' });
      }
      return proposal.id;
    },

    /** Worktree folders with a proposal nobody has answered yet. */
    pendingPaths() {
      return new Set(open().map(proposal => proposal.repo.path));
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

    /**
     * One file of a proposal as a patch, from the tree the person is confirming
     * — not from the disk, which may have moved since. Held to the size
     * list_changes inlines: past it the list's counts stand in.
     * @returns {Promise<{ patch: ?string, note: ?string }>}
     */
    async fileDiff(id, file) {
      const proposal = proposals.get(id);
      if (!proposal || proposal.outcome) throw new Error(ui`This proposal was already answered or has expired.`);
      const entry = proposal.state.files.find(item => item.path === file);
      if (!entry) throw new TypeError('Not a file of this proposal');
      if (entry.binary) return { patch: null, note: ui`A binary file: there is no text to show.` };
      const lines = (entry.insertions ?? 0) + (entry.deletions ?? 0);
      if (lines > FILE_LINE_LIMIT) return { patch: null, note: ui`${lines} changed lines, too many to show here. The Worktrees board and a terminal show them.` };
      const cwd = proposal.repo.path;
      const base = proposal.state.head ?? (await runGit({ cwd, log, argv: ['hash-object', '-t', 'tree', '--stdin'], stdin: '', operation: 'Read the empty tree' })).stdout.trim();
      const paths = [entry.originalPath, entry.path].filter(Boolean).map(item => `:(literal)${item}`);
      const result = await runGit({ cwd, log, operation: 'Read a file of a commit proposal',
        argv: ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--find-renames', base, proposal.state.tree, '--', ...paths] });
      if (result.code !== 0) throw new Error(ui`Git could not read this file.`);
      if (Buffer.byteLength(result.stdout) > DIFF_BUDGET) return { patch: null, note: ui`${lines} changed lines, too many to show here. The Worktrees board and a terminal show them.` };
      return { patch: result.stdout, note: result.stdout ? null : ui`No text change.` };
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
      if (!proposal || proposal.outcome) throw new Error(ui`This proposal was already answered or has expired.`);
      if (action === 'cancel') { settle(proposal, ui`cancelled by user`); return { outcome: ui`cancelled by user`, ok: false }; }
      if (proposal.status === 'running') throw new Error(ui`This proposal is already being committed.`);
      if (!isAllowed()) {
        settle(proposal, ui`not committed: commits from agents were turned off in 🌱 Twig`);
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
        try { validateRefName(tag); } catch { return { invalid: ui`${tag} is not a valid tag name.` }; }
        if (await readTagRef({ cwd, log, name: tag })) return { invalid: ui`The tag ${tag} already exists. Choose another name.` };
      }
      if (!committing && tag === null) return { invalid: ui`There is nothing to commit. Choose a version to bump or a tag to create.` };
      const wantPush = action === 'commit-push';
      const fresh = await readProposalState({ cwd, log });
      if (wantPush && (await pushTarget({ cwd, log, branch: proposal.state.branch })).digest !== proposal.target.digest) return refresh(proposal, 'push', message);
      if (fresh.fingerprint !== proposal.state.fingerprint) return refresh(proposal, 'files', message);
      if (fresh.settings !== proposal.state.settings) return refresh(proposal, 'settings', message);
      proposal.status = 'running';
      try {
        const outcome = await run(proposal, { message, wantPush, choice: bumping ? choice : null, committing, tag });
        if (outcome.moved) return await refresh(proposal, outcome.moved, message);
        settle(proposal, outcome.text);
        return { outcome: outcome.text, ok: outcome.ok };
      } catch (error) {
        settle(proposal, ui`not committed: ${error.message}`);
        return { outcome: proposal.outcome, ok: false };
      }
    },

    /** Turning the permission off answers every open proposal. */
    revokeAll() {
      const wasShown = shown;
      shown = null;
      for (const proposal of open()) if (proposal.status === 'pending') settle(proposal, ui`not committed: commits from agents were turned off in 🌱 Twig`);
      // A proposal already being committed keeps the dialog until it finishes.
      const running = wasShown ? proposals.get(wasShown) : null;
      if (running && !running.outcome) shown = running.id;
      else if (wasShown) present(null);
    }
  };

  async function run(proposal, { message, wantPush, choice, committing, tag }) {
    const { repo } = proposal;
    const cwd = repo.path;
    const pipeline = (event, extra = {}) => triggerPipeline({
      // A worktree nobody connected runs the automations of the repository it belongs to.
      event, repoId: repo.worktreeOf ?? repo.id, cwd, log, automations, runs, loginPath, operation: `Agent commit: ${event}`, onStep, ...extra
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
        const staged = async () => (await runGit({ cwd, log, argv: ['write-tree'], operation: 'Read the staged tree of an agent commit' })).stdout.trim();
        await stageEverything({ cwd, log });
        let bumped = [];
        let expected = proposal.state.tree;
        try {
          if (await staged() !== expected) { await restore(); return { ok: false, moved: 'files' }; }
          const pre = await pipeline('pre-commit');
          if (pre.blocked) { await restore(); return { ok: false, text: `${ui`not committed: a pre-commit automation blocked it`}\n${stepReason(pre.steps)}` }; }
          const check = await pipeline('commit-msg', { message });
          if (check.blocked) { await restore(); return { ok: false, text: `${ui`not committed: a commit-msg automation blocked it`}\n${stepReason(check.steps)}` }; }
          // An automation may format and re-stage, or something else may have
          // staged meanwhile. The person sees the result before it is committed.
          if (await staged() !== expected) { await restore(); return { ok: false, moved: 'checks' }; }
          if (bump && choice) {
            bumped = await bump.apply({ repo, choice, plan: proposal.bumpPlan });
            expected = await staged();
          }
          await createCommit({ cwd, log, message });
        } catch (error) {
          if (bumped.length) await bump.revert({ repo, applied: bumped }).catch(() => {});
          await restore();
          return { ok: false, text: `${ui`not committed: ${error.message}`}${error.detail ? `\n${error.detail}` : ''}` };
        }
        const head = await runGit({ cwd, log, argv: ['rev-parse', 'HEAD'], operation: 'Read the agent commit' });
        return { ok: true, oid: head.stdout.trim(), bumped, expected };
      });
      if (!committed.ok) return committed;
      void pipeline('post-commit').catch(() => {});
      const drift = await commitDrift({ cwd, log, expected: committed.expected, message });
      const subject = message.split('\n')[0];
      lines.push(drift.message ? ui`committed ${short(committed.oid)} on ${branch}: ${subject} (message changed by a Git hook)`
        : edited ? ui`committed ${short(committed.oid)} on ${branch}: ${subject} (message edited in 🌱 Twig)`
          : ui`committed ${short(committed.oid)} on ${branch}: ${subject}`);
      for (const item of committed.bumped || []) lines.push(`version ${item.path}: ${item.from} → ${item.to}`);
      if (drift.tree) {
        lines.push(ui`A Git hook changed what this commit takes, so it is not what you confirmed: ${drift.paths.join(', ')}. Nothing was tagged or pushed. Undo takes the commit back.`);
        return { ok: false, text: lines.join('\n') };
      }
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
    // The push the person confirmed, or none: minutes of automations may lie behind that click.
    const plan = await pushTarget({ cwd, log, branch });
    if (plan.digest !== proposal.target.digest) {
      lines.push(ui`not pushed: where it would go changed after you confirmed. Check the remote, then push from the toolbar.`);
      return { ok: false, text: lines.join('\n') };
    }
    const pushed = await undo.perform(cwd, 'sync:run', [plan.mode, branch], () => runSync({ cwd, log, mode: plan.mode, branch, plan }));
    if (pushed.ok) lines.push(`pushed to ${plan.to}`);
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
