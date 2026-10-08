// What 🌱 Twig's MCP server says about itself: protocol versions, the tool
// catalog and the shape of a tool result. Shared by the server in main and by
// the stdio bridge, which is copied next to this file into userData and runs
// on its own when 🌱 Twig is not listening — so this module has no imports.
//
// The catalog is data, not behaviour: names, descriptions and input schemas.
// The implementations live in ./tools/ and are looked up by name.

export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

export function negotiateVersion(requested) {
  return PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
}

export const SERVER_NAME = 'twig';
export const SERVER_TITLE = '🌱 Twig';

export const INSTRUCTIONS = [
  'Read-only view of Git repositories connected to 🌱 Twig, and of what is selected in its window.',
  'Each tool saves you tokens or calls over plain git, or gives you what git cannot; for anything else, use git itself.',
  'Start with get_workspace_context. Everything that changed, in one call: list_changes with diffs: true. One commit, message and patch: get_commit.',
  'Lock and generated files, very large files and what does not fit are listed by size with the git command that reads them.',
  'When code was added or removed: search_history. Who changed a line and why: get_blame.',
  'Diffs and file lists come back as plain text in git’s own shape (`M +2 -1 path`, then the hunks).',
  'With no `repository`, tools read the repository of your working directory if it is connected, else the one open in 🌱 Twig, and the answer starts with which.',
  'Nothing here changes a repository by itself. The writes, propose_commit and new_version, show your commit message and the changed files in 🌱 Twig’s window; the person edits, picks the version and tag, commits (and pushes) or cancels there, and the tool answers with what happened. There is no stage, checkout, reset or command execution.'
].join(' ');

const repository = {
  type: 'string',
  description: 'A repository connected to 🌱 Twig: its name, its root path, or any path inside it. Defaults to your working directory’s repository, else the one open in 🌱 Twig.'
};

const contextLines = { type: 'integer', minimum: 0, maximum: 20, default: 3, description: 'Unchanged lines around each change.' };

const maxBytes = { type: 'integer', minimum: 4096, maximum: 100000, default: 60000, description: 'With diffs: the most the answer may weigh. File lines always fit; patches share the rest, smallest files first.' };

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

// A commit is added, never destroyed, and only after the person confirms it; pushing reaches a remote.
const PROPOSES = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });

function tool(name, title, description, properties = {}, required = [], annotations = READ_ONLY) {
  return Object.freeze({
    name, title, description, annotations,
    inputSchema: { type: 'object', properties, required, additionalProperties: false }
  });
}

export const TOOLS = Object.freeze([
  tool('get_workspace_context', 'Workspace context',
    'Cheap summary of a repository as JSON: name and path, current branch with upstream ahead/behind, an operation in progress (merge, rebase, …), counts of staged/unstaged/untracked/conflicted files, what is selected in 🌱 Twig, and the other connected repositories (`repositories`) to pass as `repository`. No diffs. Call this first.',
    { repository }),
  tool('list_changes', 'Changed files',
    'Changed files in the working tree as text, grouped staged / unstaged / untracked, one line each: status letter, +inserted -deleted, path (a file changed in the index and on disk is listed on both sides). `diffs: true` adds each file’s patch under its line in the same answer — small files first, within `maxBytes`; lock files, generated files, files over 400 changed lines and files that did not fit are listed with the `git diff` that reads them. Paginated with `cursor`.',
    {
      repository,
      diffs: { type: 'boolean', default: false, description: 'Include each file’s patch.' },
      contextLines,
      maxBytes,
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Files per page.' },
      cursor: { type: 'string', description: 'The cursor the previous page ended with.' }
    }),
  tool('get_commit', 'One commit with its patch',
    'One commit as text in one call: full hash and subject, author, parents, the message body, then every changed file as `## M +3 -1 path` with its patch against the first parent — small files first, within `maxBytes`. Lock files, generated files, files over 400 changed lines and files that did not fit are listed with the `git show` that reads them. `diffs: false` lists the files only. Use it instead of `git show`.',
    {
      repository,
      hash: { type: 'string', description: 'Full or short hash, or a revision such as HEAD, HEAD~2 or a tag.' },
      diffs: { type: 'boolean', default: true, description: 'false: the message and file list only.' },
      contextLines,
      maxBytes
    }, ['hash']),
  tool('search_history', 'Search history',
    'When code was added or removed, showing only the changed lines that match — not whole diffs. Per commit: `hash date author: subject`, then `## M +3 -1 path` and small hunks around each match with real line numbers. mode `code`: the text appeared or disappeared (git log -S); `regex`: a changed line matches (git log -G); `message`, `author`: list commits only. HEAD by default. Use it instead of `git log -S … -p`.',
    {
      repository,
      query: { type: 'string', description: 'Text (case-sensitive), or a regex in regex mode.' },
      mode: { type: 'string', enum: ['code', 'regex', 'message', 'author'], default: 'code' },
      path: { type: 'string', description: 'Only commits that changed this file or folder.' },
      branch: { type: ['string', 'null'], default: null, description: 'Branch, tag or revision; null is HEAD.' },
      all: { type: 'boolean', default: false, description: 'Every branch and tag.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Commits per page.' },
      contextLines: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
      cursor: { type: 'string' }
    }, ['query']),
  tool('get_blame', 'Who last changed each line',
    'Who last changed each line, and why: runs like `40-58 a1b2c3d4e5f6`, then a `commits:` table with date, author and subject. No code unless `code: true`. By default the file on disk, so line numbers match your editor; uncommitted lines say `uncommitted`. Use it instead of `git blame`.',
    {
      repository,
      path: { type: 'string', description: 'Repository-relative path.' },
      startLine: { type: 'integer', minimum: 1, maximum: 50000 },
      endLine: { type: 'integer', minimum: 1, maximum: 50000 },
      revision: { type: ['string', 'null'], default: null, description: 'A commit, branch or tag; null is the file on disk.' },
      code: { type: 'boolean', default: false, description: 'Print each line under its run.' }
    }, ['path']),
  tool('get_ui_context', 'What is selected in 🌱 Twig',
    'What the person is looking at in 🌱 Twig right now: the open repository, the view (history, changes, staging, compare, blame, conflict, …), the selected commit(s) and the selected file. Fields 🌱 Twig does not track are null; there is no hunk selection.'),
  tool('propose_commit', 'Propose a commit',
    'Asks the person to commit ALL current changes (like `git add -A`) with your message. 🌱 Twig shows the repository, branch, files and your message (editable) and waits; nothing happens until the person presses Commit or Commit & Push there. The commit runs the person’s automations (pre-commit, commit-msg) and can be undone in 🌱 Twig. Answers in plain text: `committed <hash> on <branch>: <subject>`, `pushed to <remote/branch>`, `cancelled by user`, or `not committed: <reason>`. If the person takes longer than ~45 s, the answer is `waiting` with a proposalId for await_commit. Off unless the person allowed it (WRITE_DISABLED). Do not add Co-Authored-By trailers unless asked.',
    {
      repository,
      message: { type: 'string', description: 'The full commit message: subject line, blank line, body.' },
      push: { type: 'boolean', default: false, description: 'Suggest Commit & Push: after committing, push to the upstream (or set origin/<branch> as upstream). The person can still choose Commit only.' }
    }, ['message'], PROPOSES),
  tool('new_version', 'Propose a new version',
    'Asks the person to release a new version: commit ALL current changes together with a version bump, tag that commit, and with Commit & Push push the commit and the tag. 🌱 Twig shows the same dialog as propose_commit with two switches on: Bump version (package.json, and package-lock.json’s root entries; your `bump` is preselected; with no package.json the version comes from the previous tag) and Tag this commit (named after the previous tag, e.g. v1.2.3 → v1.2.4, or `tag`). The person can change both. Works on a clean tree too: the commit is the bump alone, or with no bump only HEAD is tagged. Answers like propose_commit, plus `version <file>: 1.2.3 → 1.2.4`, `tagged <tag> at <hash>`, `pushed tag <tag> to <remote>`. Do not bump the version in the files yourself before calling it.',
    {
      repository,
      bump: { type: 'string', enum: ['patch', 'minor', 'major'], default: 'patch', description: 'The version step to preselect.' },
      message: { type: 'string', description: 'The commit message. Omit it for `chore(release): <version>`, which follows the version the person picks.' },
      tag: { type: 'string', description: 'A tag name to suggest instead of the one made from the previous tag.' },
      push: { type: 'boolean', default: true, description: 'Suggest Commit & Push (the commit and the tag). The person can still choose Commit only.' }
    }, [], PROPOSES),
  tool('await_commit', 'Wait for a proposed commit',
    'Waits up to ~45 s more for the person’s answer to a propose_commit or new_version that came back `waiting`, and answers the same way they do.',
    { proposalId: { type: 'string', description: 'The proposalId from a `waiting` answer.' } }, ['proposalId'], PROPOSES)
]);

/**
 * A tool result as MCP carries it. The payload goes out once: text as it is
 * (diffs and file lists are plain text), anything else as compact JSON. An
 * agent reads the text block, and repeating the same object as
 * `structuredContent` would double what every call costs it.
 */
export function toolResult(payload, isError = false) {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

/**
 * Where the stdio bridge puts its own working directory in the client's
 * `initialize` (`params._meta`). An MCP client starts the bridge in the
 * project it works on, so this is the repository the agent means when it
 * names none.
 */
export const CWD_META = 'app.nodex.twig/cwd';

export function errorResult(code, message, extra = {}) {
  return toolResult({ error: { code, message, ...extra } }, true);
}

export const UNAVAILABLE_MESSAGE = '🌱 Twig is not running, or Settings → AI agents (MCP) is off. Open 🌱 Twig and turn it on, then call the tool again.';
