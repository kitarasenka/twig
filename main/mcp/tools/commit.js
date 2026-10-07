import { McpError } from '../errors.js';
import { WAIT_MS } from '../commit-proposal.js';

/**
 * The only tools that change a repository — and they do not do it
 * themselves: a proposal is shown in 🌱 Twig's window and the person commits
 * it there (or not). The call waits a while for that answer; past it the
 * agent gets the proposal id to wait on with await_commit, so no call outlives
 * a client's tool timeout.
 */
function pending(id) {
  return `waiting: the person has not answered in 🌱 Twig yet. Call await_commit with proposalId "${id}" (it waits up to ${Math.round(WAIT_MS / 1000)} s).\n`;
}

function proposals(ctx) {
  if (!ctx.proposals) throw new McpError('WRITE_DISABLED', 'This 🌱 Twig does not take commit proposals.');
  return ctx.proposals;
}

export async function proposeCommit(ctx, args) {
  const store = proposals(ctx);
  const repo = ctx.repository(args.repository);
  const id = await store.propose({ repo, message: args.message, push: args.push });
  const outcome = await store.wait(id, ctx.waitMs ?? WAIT_MS);
  return outcome ? `${outcome}\n` : pending(id);
}

/** propose_commit for a release: the same dialog with the version bump and the tag switched on. */
export async function newVersion(ctx, args) {
  const store = proposals(ctx);
  const repo = ctx.repository(args.repository);
  const id = await store.propose({ repo, kind: 'release', message: args.message ?? null, push: args.push, bump: args.bump, tag: args.tag ?? null });
  const outcome = await store.wait(id, ctx.waitMs ?? WAIT_MS);
  return outcome ? `${outcome}\n` : pending(id);
}

export async function awaitCommit(ctx, args) {
  const outcome = await proposals(ctx).wait(args.proposalId, ctx.waitMs ?? WAIT_MS);
  return outcome ? `${outcome}\n` : pending(args.proposalId);
}
