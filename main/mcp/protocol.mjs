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
  'For everything that changed, one call: list_changes with diffs: true — every file with its patch, lock files and very large files listed by size only.',
  'To go smaller: get_diff (one file) → get_diff_hunk (one hunk); for history: get_history → get_commit → get_commit_diff.',
  'Diffs and file lists come back as plain text in git’s own shape (`M +2 -1 path`, then the hunks).',
  'With no `repository`, tools read the repository of your working directory if it is connected, else the one open in 🌱 Twig, and the answer starts with which.',
  'Nothing here changes a repository: there is no commit, stage, checkout or command execution.'
].join(' ');

const repository = {
  type: 'string',
  description: 'A repository connected to 🌱 Twig: its name, its root path, or any path inside it. Defaults to your working directory’s repository, else the one open in 🌱 Twig.'
};

const contextLines = { type: 'integer', minimum: 0, maximum: 20, default: 3, description: 'Unchanged lines around each change.' };

const READ_ONLY = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

function tool(name, title, description, properties = {}, required = []) {
  return Object.freeze({
    name, title, description, annotations: READ_ONLY,
    inputSchema: { type: 'object', properties, required, additionalProperties: false }
  });
}

export const TOOLS = Object.freeze([
  tool('get_workspace_context', 'Workspace context',
    'Cheap summary of a repository: name and path, current branch with upstream ahead/behind, an operation in progress (merge, rebase, …), counts of staged/unstaged/untracked/conflicted files, and what is selected in 🌱 Twig. No diffs. Call this first.',
    { repository }),
  tool('list_repositories', 'Connected repositories',
    'Repositories connected to 🌱 Twig, and which one is open in its window. Use a path from here as `repository` in other tools.'),
  tool('list_changes', 'Changed files',
    'Changed files in the working tree as text, grouped staged / unstaged / untracked, one line each: status letter, +inserted -deleted, path (a file changed in the index and on disk is listed on both sides). `diffs: true` adds each file’s patch under its line in the same answer — small files first, within `maxBytes`; lock files, generated files and files over 400 changed lines are listed with the reason and read with get_diff. Paginated with `cursor`.',
    {
      repository,
      diffs: { type: 'boolean', default: false, description: 'Include each file’s patch.' },
      contextLines,
      maxBytes: { type: 'integer', minimum: 4096, maximum: 100000, default: 60000, description: 'With diffs: the most the answer may weigh. File lines always fit; patches share the rest, smallest files first.' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Files per page.' },
      cursor: { type: 'string', description: 'The cursor the previous page ended with.' }
    }),
  tool('get_diff', 'Diff of one file',
    'Diff of ONE changed file in the working tree as text: its line (`M +2 -1 path (unstaged)`), then the hunks. `staged: true` reads the index side. An untracked file is shown as the patch that would add it. Hunks past one answer’s budget are printed as their header with an id and marked "not shown" — read them with get_diff_hunk.',
    {
      repository,
      path: { type: 'string', description: 'Repository-relative path, as list_changes prints it.' },
      staged: { type: 'boolean', default: false, description: 'true for the staged side (index vs HEAD), false for unstaged (working tree vs index).' },
      contextLines
    }, ['path']),
  tool('get_diff_hunk', 'One hunk of a file diff',
    'One hunk that get_diff marked "not shown", by its id. The id carries the side and context it was read with. INVALID_HUNK means the file changed since: call get_diff again.',
    {
      repository,
      path: { type: 'string', description: 'Repository-relative path.' },
      hunkId: { type: 'string', description: 'A hunk id get_diff printed.' }
    }, ['path', 'hunkId']),
  tool('get_history', 'Commit history',
    'Commit list as text, newest first, one line each: short hash, date, author, subject (merges name their parents). No diffs. Defaults to the history of HEAD; `branch` reads another branch or tag; `all: true` reads every branch like 🌱 Twig’s graph.',
    {
      repository,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Commits per page.' },
      branch: { type: ['string', 'null'], default: null, description: 'Branch, tag or revision (e.g. origin/main, v1.2, HEAD~10). null means HEAD.' },
      all: { type: 'boolean', default: false, description: 'Every branch, tag and remote branch together.' },
      cursor: { type: 'string', description: 'The cursor the previous page ended with.' }
    }),
  tool('get_commit', 'One commit',
    'One commit as text: full hash and subject, author, parents, the message body, then its changed files as `M +3 -1 path`. No patch — use get_commit_diff.',
    {
      repository,
      hash: { type: 'string', description: 'Full or short hash, or a revision such as HEAD or HEAD~2.' }
    }, ['hash']),
  tool('get_commit_diff', 'Diff of a commit',
    'Patch of one commit against its first parent, as text. Pass `path` for one file, and `hunkId` with it for a hunk marked "not shown". Without `path`, small commits come back whole; large ones as their file list.',
    {
      repository,
      hash: { type: 'string', description: 'Full or short hash, or a revision such as HEAD.' },
      path: { type: 'string', description: 'One changed file in that commit.' },
      hunkId: { type: 'string', description: 'A hunk id an earlier get_commit_diff of the same file printed.' }
    }, ['hash']),
  tool('get_ui_context', 'What is selected in 🌱 Twig',
    'What the person is looking at in 🌱 Twig right now: the open repository, the view (history, changes, staging, compare, blame, conflict, …), the selected commit(s) and the selected file. Fields 🌱 Twig does not track are null; there is no hunk selection.')
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
