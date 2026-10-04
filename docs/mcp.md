# 🌱 Twig MCP server

🌱 Twig includes a [Model Context Protocol](https://modelcontextprotocol.io) server. Coding
agents such as Claude Code, Codex and Cursor can use it to read structured context from
the Git repositories you connected in 🌱 Twig, and to see what is selected in its window.

It is **not** a wrapper around the `git` CLI. The tools return small JSON answers built
from 🌱 Twig's own Git layer, the same readers the graph, staging screen and commit panel use.
They are designed for *progressive disclosure*: start with a cheap summary, then ask for one
file, then one hunk.

The first version is **read-only**. No tool commits, stages, checks out, resets, merges,
rebases, pushes, deletes a branch, or runs a command.

## Turn it on

1. Press **MCP** in the toolbar, next to BugHunter. **Settings → Set up AI agents**
   opens the same panel. The panel explains what an agent gets and gives prompts to try.
2. Switch **MCP server** to **On**. It stays on across restarts and is **Off** by default.
   While it is on, the toolbar button shows a dot, and its name and tooltip say "on".
3. Copy the configuration for your client from the same panel.

While the server is on, 🌱 Twig listens on a local socket and does nothing else. When it is
off, nothing listens at all.

## Connect a client

The panel shows the exact command for your installation. The bridge runs on 🌱 Twig's own
executable with `ELECTRON_RUN_AS_NODE=1`, so you don't need a separate Node.js install. The
paths below are macOS examples. Copy the real ones from Settings.

**Claude Code** (once, in a terminal; `--scope user` makes it available in every project):

```sh
claude mcp add --scope user twig --env ELECTRON_RUN_AS_NODE=1 -- \
  '/Applications/🌱 Twig.app/Contents/MacOS/🌱 Twig' \
  '/Users/you/Library/Application Support/twig/mcp/twig-mcp.mjs'
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.twig]
command = "/Applications/🌱 Twig.app/Contents/MacOS/🌱 Twig"
args = ["/Users/you/Library/Application Support/twig/mcp/twig-mcp.mjs"]
env = { ELECTRON_RUN_AS_NODE = "1" }
```

**Cursor and other clients**, in `~/.cursor/mcp.json` or your client's `mcpServers` file:

```json
{
  "mcpServers": {
    "twig": {
      "command": "/Applications/🌱 Twig.app/Contents/MacOS/🌱 Twig",
      "args": ["/Users/you/Library/Application Support/twig/mcp/twig-mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

If 🌱 Twig is closed or the server is off, the client still lists the tools, and every call
returns `TWIG_UNAVAILABLE` with an explanation. Open 🌱 Twig, turn the server on, and the
same client session reconnects by itself.

**Running from source:** the command is `node_modules/electron/dist/…/Electron` from your
checkout, which Settings shows. `node <userData>/mcp/twig-mcp.mjs` also works when Node 20+
is installed.

## Tools

Every repository-scoped tool takes an optional `repository`: a connected repository's name,
its root path, or **any path inside it**, so an agent can pass its working directory. Without
it, the tool reads the repository open in 🌱 Twig. Answers include `repository` (the root
path), so an agent can check it got the repository it meant.

| Tool | Arguments | Returns |
|---|---|---|
| `get_workspace_context` | `repository?` | Name and path, branch (head, upstream, ahead/behind), operation in progress (merge, rebase, cherry-pick, revert, am) with conflict count, counts of staged/unstaged/untracked/conflicted/modified/added/deleted/renamed files, and the selection in 🌱 Twig. No diffs, usually under 800 bytes. |
| `list_repositories` | — | Connected repositories, and which one is open in 🌱 Twig. |
| `list_changes` | `repository?`, `limit` (1–1000, 200), `cursor?` | One entry per changed file and side: `path`, `status`, `staged`, `insertions`, `deletions` (and `originalPath` for renames, `binary`). A file changed in both the index and on disk appears twice. Untracked files are listed one by one. Paginated. |
| `get_diff` | `path`, `staged` (false), `contextLines` (0–20, 3), `repository?` | One file's diff, split into hunks with `id`, ranges, `heading`, `added`/`removed` and `patch`. An untracked file is shown as the patch that would add it. Conflicted files and submodules are described, not diffed. |
| `get_diff_hunk` | `path`, `hunkId`, `repository?` | Exactly one hunk from `get_diff`. |
| `get_history` | `limit` (1–100, 20), `branch?` (null = HEAD), `all` (false), `cursor?`, `repository?` | `hash`, `message` (subject), `author`, `date`, `parents`. No diffs. `all: true` reads every ref, like 🌱 Twig's graph. |
| `get_commit` | `hash`, `repository?` | Metadata, full message, parents, changed files with insertions/deletions, totals. No patch. `hash` may be short, or a revision such as `HEAD~2`. |
| `get_commit_diff` | `hash`, `path?`, `hunkId?`, `repository?` | Patch against the first parent. With `path`: one file (hunks with ids); with `path` + `hunkId`: one hunk. Without `path`: the whole commit if it is small (≤ 60 files and ≤ 4000 changed lines), otherwise the file list with `truncated: true`. |
| `get_ui_context` | — | What the person is looking at in 🌱 Twig: `repository`, `view` (history, changes, staging, compare, file-history, blame, conflict, branches, stashes, reflog, worktrees, submodules, maintenance, automations), `selectedCommit`, `selectedCommits`, `compare`, `selectedFile` (`path`, `commit`, `side`). `selectedBranch` and `selectedHunk` are always null, because 🌱 Twig doesn't track either. |

There is deliberately no `get_everything`.

### Hunk ids

A hunk id looks like `w3-1a2b3c4d5e6f`:

- The first letter is the side the hunk was read from: `w` working tree, `s` staged,
  `u` untracked, `c` a commit.
- The number is the context line count.
- The rest is a hash of the path and the hunk's text.

Ids are checked, not trusted. Asking for a hunk re-reads the diff the same way and returns it
only if it is still exactly there. If the file changed in between, the answer is
`INVALID_HUNK`, never a neighbouring hunk.

### Size limits

- A diff answer carries up to about 60 KB of patch text. Past that, the remaining hunks come
  back with their metadata and `patch: null`, plus `truncated: true` and a `hint`. The JSON is
  never cut mid-way.
- A single hunk requested by id is cut at a line boundary past about 80 KB, with
  `truncated: true` and `omittedLines`.
- `get_commit` lists up to 300 files.
- Untracked files over 1 MB are described, not diffed.
- Any tool result over 120 000 characters is replaced by `OUTPUT_TOO_LARGE` with a hint.

### Errors

Errors are tool results with `isError: true` and this text:

```json
{ "error": { "code": "FILE_NOT_FOUND", "message": "README.md has no staged changes; its changes are not staged.", "hint": "Call get_diff with staged: false." } }
```

| Code | Meaning |
|---|---|
| `NO_REPOSITORY_OPEN` | No `repository` was passed and none is open in 🌱 Twig. |
| `REPOSITORY_NOT_FOUND` | `repository` matches no connected repository, or the repository is unavailable. |
| `FILE_NOT_FOUND` | The path has no changes on that side, or did not change in that commit. |
| `COMMIT_NOT_FOUND` | No commit matches the hash (including an ambiguous short hash). |
| `REF_NOT_FOUND` | No branch, tag or revision has that name. |
| `INVALID_HUNK` | The hunk id is malformed or no longer matches the file. |
| `INVALID_ARGUMENT` | An argument is missing, has the wrong type, is out of range, or is a path outside the repository. |
| `OUTPUT_TOO_LARGE` | The answer would be too large; ask for something smaller. |
| `GIT_OPERATION_FAILED` | Git failed. The exact command is in 🌱 Twig's console. |
| `TWIG_UNAVAILABLE` | Returned by the bridge: 🌱 Twig is not running, or the server is off. |

Unknown tools and methods are JSON-RPC errors (`-32602`, `-32601`).

## Example

> **You:** Look at my current changes and suggest how to split them into commits.

A well-behaved agent:

1. Calls `get_workspace_context` to see the branch, that nothing is mid-merge, and how many
   files are staged and unstaged.
2. Calls `list_changes` to get paths, statuses and line counts.
3. Calls `get_diff` only for the files it needs to read, and `get_diff_hunk` for hunks
   that were left out of a large diff.
4. Proposes a commit plan: which files and hunks go together, and a message for each.

The agent only *proposes* the plan. The MCP server can't stage or commit anything; you carry
out the plan in 🌱 Twig, where staging works by line and every step can be undone.

## Security model

- **Off by default.** No socket exists until you turn the server on in Settings.
- **Local only.** 🌱 Twig listens on a Unix domain socket inside a folder that only your
  account can open (`0700`, socket `0600`), or a named pipe on Windows. There is no TCP port
  and no network listener. If the userData path is too long for a socket, 🌱 Twig uses a `0700`
  folder under your temp directory. It refuses to listen there if the folder belongs to anyone
  else or other users can open it.
- **Read-only.** Every tool only reads. There is no `run_command`, `run_git`, `shell` or
  `execute`, and no write tool. The catalog marks every tool `readOnlyHint: true`.
- **Connected repositories only.** `repository` is resolved against the list you connected in
  🌱 Twig. An agent can't point the server at an arbitrary folder, and file paths are checked
  to stay inside the repository.
- **No index churn.** Working-tree reads run with `GIT_OPTIONAL_LOCKS=0`, so an agent's
  `status` or `diff` never rewrites the index or races a commit you are making. The check
  suite verifies that `.git` and the working tree stay byte-for-byte unchanged.
- **Visible.** Every Git command an agent causes goes into 🌱 Twig's console journal, with its
  operation prefixed `MCP:` and an **MCP** tag. It appears under **Full History**, not under
  **My**.
- **UI context stays in memory.** The window reports its selection to the main process, which
  keeps the last report in memory only and never writes it to disk.
- **Provider-agnostic.** No AI SDK is involved. The server speaks plain MCP (JSON-RPC 2.0;
  protocol versions 2025-06-18, 2025-03-26 and 2024-11-05) and works with any client.

Any process running as your user can connect to the socket while the server is on. Such a
process could read the same repositories directly anyway.

## Architecture

```
AI client ──stdio──▶ twig-mcp.mjs (bridge) ──local socket──▶ 🌱 Twig main process
                                                              main/mcp/session.js  (JSON-RPC, MCP methods)
                                                              main/mcp/tools/*.js  (one small reader per tool)
                                                              main/git/*.js        (🌱 Twig's Git layer, runGit)
```

- `main/mcp/protocol.mjs`: protocol versions, the tool catalog (names, descriptions, input
  schemas) and the result shape. It has no imports, because the bridge uses it too.
- `main/mcp/session.js`: one MCP conversation, independent of how bytes arrive. A future HTTP
  transport would reuse it unchanged.
- `main/mcp/socket-transport.js`: newline-delimited JSON-RPC over the local socket.
- `main/mcp/twig-mcp.mjs`: the stdio bridge. 🌱 Twig copies it and `protocol.mjs` into
  `userData/mcp/` when the server is on, together with `endpoint.json` (socket path and
  version). The bridge retries the socket on every message and replays the client's
  `initialize` when it attaches mid-session.
- `main/mcp/tools/`: `workspace.js`, `changes.js`, `history.js` and `ui.js`. The tools contain
  no Git parsing; they call `loadWorktree`, `loadWorktreeDiff`, `loadUntrackedDiff`,
  `loadWorktreeNumstat`, `loadCommit`, `loadCommitNumstat`, `loadFileDiff`,
  `loadCommitPatch`, `loadHistoryPage`, `loadRefHistory`, `resolveRevision` and
  `loadOperationState`.
- `main/mcp/context.js`: resolves the repository, tags journal entries `MCP:` and sets the
  read environment. `main/mcp/serialize.js` holds hunk ids, budgets and status words.
  `main/mcp/ui-context.js` validates the window's reports.
- `main/mcp/service.js` (lifecycle, no Electron imports), `main/mcp-ipc.js` (Settings
  channels and the UI report) and `main/mcp-store.js` (`mcp.json`, the on/off choice).

## Testing locally

```sh
node scripts/checks/mcp.mjs     # part of npm test: tools on real repositories, read-only, transport, bridge
npm run build && node scripts/mcp-smoke.mjs   # part of npm run test:smoke: Settings, a real bridge on the app executable
```

To try it by hand, run 🌱 Twig from source (`npm run dev`), turn the server on, then use the
MCP Inspector with the command and arguments from Settings:

```sh
ELECTRON_RUN_AS_NODE=1 npx @modelcontextprotocol/inspector "<command from Settings>" "<bridge path from Settings>"
```

## Limitations

- Read-only. No write tools yet.
- The only transport is local stdio through the socket bridge. HTTP is not offered.
- Hunks are identified per file and side. There is no hunk *selection* in 🌱 Twig to report,
  and no branch selection.
- `get_ui_context` reports the history workspace: the selected commit(s), compare range,
  open file diff, file history, blame and conflict file. File selection inside the staging
  screen is not reported.
- Commit diffs are against the first parent, with a context of 3 lines.
- Verified live on macOS arm64, running from source. For a packaged macOS build, only the
  bridge running on the packaged executable was checked. The Windows named pipe, AppImage
  (`$APPIMAGE` as the command) and deb paths follow the same code but have not been run.

## Next phase (not implemented)

Write tools such as `propose_commit_plan`, `stage_hunk`, `unstage_hunk`, `create_branch`,
`create_commit`, `checkout` and `merge` would need:

- a separate capability that the person grants in Settings, off even when reading is on;
- a confirmation in 🌱 Twig's window for each mutation, showing the exact command, like the
  app's other confirmation dialogs;
- the existing Undo service, so an agent's action can be undone like the person's own;
- the same hunk ids as now, so `stage_hunk` applies exactly the hunk the agent read.
  Staging already works this way: main re-reads the diff and refuses if it changed.
