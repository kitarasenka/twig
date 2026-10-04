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
  'Read-only, structured view of Git repositories connected to 🌱 Twig, and of what is selected in its window.',
  'Work from small to large: get_workspace_context → list_changes → get_diff (one file) → get_diff_hunk (one hunk);',
  'for history: get_history → get_commit → get_commit_diff (one file, or one hunk).',
  'Tools default to the repository open in 🌱 Twig; pass `repository` (your working directory works) to choose another connected one.',
  'Nothing here changes a repository: there is no commit, stage, checkout or command execution.'
].join(' ');

const repository = {
  type: 'string',
  description: 'A repository connected to 🌱 Twig: its name, its root path, or any path inside it (your working directory works). Defaults to the repository open in 🌱 Twig.'
};

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
    'Changed files in the working tree, without diffs: path, status, whether the entry is staged, and lines inserted/deleted. A file changed both in the index and on disk appears twice (staged: true and staged: false). Paginated with `cursor`.',
    {
      repository,
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Files per page.' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' }
    }),
  tool('get_diff', 'Diff of one file',
    'Diff of ONE changed file in the working tree, split into hunks with ids. `staged: true` reads the index side. An untracked file is shown as the patch that would add it. Large diffs come back with hunk metadata only and `truncated: true` — fetch hunks one by one with get_diff_hunk.',
    {
      repository,
      path: { type: 'string', description: 'Repository-relative path, as list_changes reports it.' },
      staged: { type: 'boolean', default: false, description: 'true for the staged side (index vs HEAD), false for unstaged (working tree vs index).' },
      contextLines: { type: 'integer', minimum: 0, maximum: 20, default: 3, description: 'Unchanged lines around each change.' }
    }, ['path']),
  tool('get_diff_hunk', 'One hunk of a file diff',
    'A single hunk from get_diff, by its id. The id carries the side and context it was read with. INVALID_HUNK means the file changed since: call get_diff again.',
    {
      repository,
      path: { type: 'string', description: 'Repository-relative path.' },
      hunkId: { type: 'string', description: 'A hunk id from get_diff.' }
    }, ['path', 'hunkId']),
  tool('get_history', 'Commit history',
    'Compact commit list, newest first: hash, subject, author, date, parents. No diffs. Defaults to the history of HEAD; `branch` reads another branch or tag; `all: true` reads every branch like 🌱 Twig’s graph.',
    {
      repository,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20, description: 'Commits per page.' },
      branch: { type: ['string', 'null'], default: null, description: 'Branch, tag or revision (e.g. origin/main, v1.2, HEAD~10). null means HEAD.' },
      all: { type: 'boolean', default: false, description: 'Every branch, tag and remote branch together.' },
      cursor: { type: 'string', description: 'nextCursor from the previous page.' }
    }),
  tool('get_commit', 'One commit',
    'Metadata, full message, parents and the changed files of one commit with lines inserted/deleted per file. No patch — use get_commit_diff.',
    {
      repository,
      hash: { type: 'string', description: 'Full or short hash, or a revision such as HEAD or HEAD~2.' }
    }, ['hash']),
  tool('get_commit_diff', 'Diff of a commit',
    'Patch of one commit against its first parent. Pass `path` for one file (preferred), and `hunkId` with it for one hunk. Without `path`, small commits come back whole; large ones come back as a file list with `truncated: true`.',
    {
      repository,
      hash: { type: 'string', description: 'Full or short hash, or a revision such as HEAD.' },
      path: { type: 'string', description: 'One changed file in that commit.' },
      hunkId: { type: 'string', description: 'A hunk id from an earlier get_commit_diff of the same file.' }
    }, ['hash']),
  tool('get_ui_context', 'What is selected in 🌱 Twig',
    'What the person is looking at in 🌱 Twig right now: the open repository, the view (history, changes, staging, compare, blame, conflict, …), the selected commit(s) and the selected file. Fields 🌱 Twig does not track are null; there is no hunk selection.')
]);

/**
 * A tool result as MCP carries it. The payload goes out once, as compact JSON
 * text: an agent reads the text block, and repeating the same object as
 * `structuredContent` would double what every call costs it.
 */
export function toolResult(payload, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

export function errorResult(code, message, extra = {}) {
  return toolResult({ error: { code, message, ...extra } }, true);
}

export const UNAVAILABLE_MESSAGE = '🌱 Twig is not running, or Settings → AI agents (MCP) is off. Open 🌱 Twig and turn it on, then call the tool again.';
