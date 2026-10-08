# 🌱 Twig MCP server

🌱 Twig includes a [Model Context Protocol](https://modelcontextprotocol.io) server. Coding
agents such as Claude Code, Codex and Cursor can use it to read structured context from
the Git repositories you connected in 🌱 Twig, and to see what is selected in its window.

It is **not** a wrapper around the `git` CLI. A tool is here only if it saves an agent
something over running git itself (fewer tokens, fewer calls) or gives it something git
can't: what you selected in 🌱 Twig, or your confirmation of a commit. Anything git already
answers compactly, such as a commit list (`git log --oneline`) or one file's diff
(`git diff -- <path>`), is left to git. The tools answer from 🌱 Twig's own Git layer, the
same readers the graph, staging screen and commit panel use:

- **One call for all changes.** `list_changes` with `diffs: true` returns every changed file
  with its patch. Lock files, minified output and very large files are listed with their
  line counts and the `git diff` that reads them instead of being inlined, so a 12 MB
  generated file costs one line.
- **One call for a commit.** `get_commit` returns the message and every file's patch the
  same way, so explaining a commit doesn't need a second call.
- **Plain text, in git's own shapes.** File lists look like `M +2 -1 src/app.js`; diffs are
  ordinary unified hunks. Nothing is escaped into JSON strings, so an answer is no larger
  than the same information from `git diff --numstat` plus `git diff`, and usually smaller,
  because the per-file `diff --git` / `index` / `---` / `+++` headers are left out.
- **Search that filters, not just repackages.** `git log -S foo -p` hands back every hunk of
  every file that matched; `search_history` returns only a few lines around each changed line
  that contains `foo`. `get_blame` turns one line per source line into one line per run of
  lines from the same commit, with each commit's subject once. See
  [Searching history and blame](#searching-history-and-blame).

Reading is all an agent can do on its own. The writes, [`propose_commit`](#proposing-a-commit)
and [`new_version`](#a-new-version), are off unless you allow them, and even then they only
*ask*: 🌱 Twig shows the commit in its window and nothing happens until you press Commit there. No tool stages, checks out, resets,
merges, rebases, deletes a branch, or runs a command.

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
its root path, or **any path inside it**. Usually it can be left out:

1. The bridge reports the folder the MCP client started it in (the agent's project), and
   tools read that repository if it is connected. Symlinked paths such as `/var` and
   `/private/var` on macOS are matched both ways.
2. Otherwise tools read the repository open in 🌱 Twig, and the answer **starts with**
   `repository: <path>` and, if the agent's folder is known, a `note:` saying that folder is
   not connected. A guess is always visible; a repository the agent named, or its own,
   is not echoed back.

### Answer formats

Lists and diffs are plain text; small state answers are JSON.

```
on main: 1 staged, 2 unstaged, 1 untracked
staged:
## M +2 -0 README.md
@@ -1 +1,3 @@
 # Alpha
+
+Staged line.
unstaged:
## M +1 -1 package-lock.json
(lock or generated file: git diff -- package-lock.json)
## M +2 -0 src/app.js
@@ -1 +1,3 @@
 export const one = 1;
+export const two = 2;
+export const three = 3;
untracked:
## ? +2 -0 notes/todo.txt
@@ -0,0 +1,2 @@
+one
+two
```

That is `list_changes` with `diffs: true`. Without `diffs`, each file is just its line
(`M +2 -0 src/app.js`) under the same section headers. A file line is the status letter as
`git status --short` prints it, then `+inserted -deleted` (`bin` for binary, nothing when not
yet counted), then the path. A rename is `old -> new`. A path is quoted like a JSON string
only when it has control characters, quotes, leading/trailing spaces or ` -> `.

| Tool | Arguments | Returns |
|---|---|---|
| `get_workspace_context` | `repository?` | JSON. Name and path, branch (head, upstream, ahead/behind), operation in progress (merge, rebase, cherry-pick, revert, am) with conflict count, counts of staged/unstaged/untracked/conflicted/modified/added/deleted/renamed files, the selection in 🌱 Twig, and `repositories`: the other connected repositories (`name`, `path`, `openInTwig`, `available: false` when missing, `demo`). Usually under 800 bytes. With no repository to read, it still answers, with `repository: null`, the `reason` and the list. |
| `list_changes` | `repository?`, `diffs` (false), `contextLines` (0–20, 3), `maxBytes` (4096–100000, 60000), `limit` (1–1000, 200), `cursor?` | Text. The branch and counts, then the files grouped `staged:` / `unstaged:` / `untracked:`, one line each. A file changed in both the index and on disk appears on both sides. With `diffs: true`, each file's patch follows its line — see [What `diffs: true` leaves out](#what-diffs-true-leaves-out). Paginated: a last line names the next `cursor`. |
| `get_commit` | `hash`, `diffs` (true), `contextLines` (0–20, 3), `maxBytes` (4096–100000, 60000), `repository?` | Text: full hash and subject, author, committer date if different, parents, the message body, then every changed file as `## M +3 -1 path` with its patch against the first parent (a merge says `against the first parent`). Left out the same way as `list_changes`, with `git show --format= <hash> -- <path>` to read it. `diffs: false` lists the files only. `hash` may be short, or a revision such as `HEAD~2` or a tag. |
| `search_history` | `query`, `mode` (code, regex, message, author; code), `path?`, `branch?` (null = HEAD), `all` (false), `limit` (1–50, 10), `contextLines` (0–10, 3), `cursor?`, `repository?` | Text. Commits newest first, one line each; for `code` and `regex`, each matching file as `## M +3 -1 path` and small hunks around the matching lines. See [Searching history and blame](#searching-history-and-blame). |
| `get_blame` | `path`, `startLine?`, `endLine?`, `revision?` (null = the file on disk), `code` (false), `repository?` | Text. Runs of lines from the same commit (`40-58 a1b2c3d4e5f6`, `61 uncommitted`), then `commits:` — hash, date, author and subject of each, newest first. With `code: true`, each line's text under its run, after a tab. |
| `get_ui_context` | — | What the person is looking at in 🌱 Twig: `repository`, `view` (history, changes, staging, compare, file-history, blame, conflict, branches, stashes, reflog, worktrees, submodules, maintenance, automations), `selectedCommit`, `selectedCommits`, `compare`, `selectedFile` (`path`, `commit`, `side`). `selectedBranch` and `selectedHunk` are always null, because 🌱 Twig doesn't track either. |

### What `diffs: true` leaves out

`list_changes` and `get_commit` show each file whole or list it with its reason in
parentheses:

- **Lock and generated files**: `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`,
  `Cargo.lock`, `go.sum` and other lock files, `*.min.js`, `*.min.css`, source maps. Mark
  more with `-diff` in `.gitattributes`: Git then counts them as binary (`bin`).
- **Large files**: more than 400 changed lines.
- **Budget**: the whole answer stays within `maxBytes` (60 000 by default, 4096 at least).
  Every file line of the page always fits; the patches share what is left, smallest files
  first, so the budget runs out on the big ones. Those say `(did not fit in this answer)`, and
  the answer ends with one command for all of them:
  `Did not fit, all in one call: git diff -- a.js b.js` (one per side of the index for
  `list_changes`, `git show --format= <hash> -- …` for `get_commit`). If the file lines alone
  fill a small budget, use `limit` to page.
- Binary files, conflicts, submodules, type changes, renames with edits, and more than 40
  untracked files in one answer.

Every reason names the command that reads the file: `git diff [--cached] -- <path>`
(with `-U<n>` when you asked for other than 3 context lines, `-M -- old new` for a rename),
`git show --format= <hash> -- <path>` for a commit, or "read the file itself" for a new file.
Paths are quoted for a POSIX shell when they need it. Tracked files are read with one
`git diff` per side of the index, and a commit with one `git show`, not one per file. Paths
Git quotes in a patch header are read one by one.

### Searching history and blame

`search_history` answers "when was this added or removed" without whole diffs:

```text
HEAD: commits where "readPreviousTag" was added or removed, newest first:
c972cb2630f1 2026-10-07 ktarasenko: feat(mcp): new_version tool and version/tag switches …
## M +141 -59 main/mcp/commit-proposal.js
@@ -73,0 +81,7 @@ export async function readProposalState({ cwd, log }) {
+ * The newest tag reachable from HEAD that carries an X.Y.Z, parsed — the
+ * pattern a release tag follows (`twig-v0.16.2` → `twig-v0.16.3`) — or null.
+ */
+export async function readPreviousTag({ cwd, log, head }) {
…
```

- `code` is `git log -S`: the number of occurrences of the text changed, so a line that only
  moved does not count. `regex` is `git log -G` (POSIX extended): an added or removed line
  matches. The matching lines are found again in the patch (a `regex` with syntax JavaScript
  cannot read lists the file without marking lines). `message` and `author` list commits only.
- Each window is the matching lines with `contextLines` around them, inside their hunk, with
  a header carrying the real line numbers and the hunk's heading. Windows that touch merge.
  A file shows at most 5; the rest are counted, with the `git show --format= <hash> -- <path>` that reads it whole.
- Lock and generated files are listed, not shown, as in `list_changes`, with the same `git show`.
- An answer holds about 60 KB. Commits go in whole; one that does not fit starts the next page
  (`… more: search_history with cursor "N"`). A search reads at most its first 1000 matches.
  Pages are read as the first `cursor + limit` matches, because Git applies `--skip` before
  `-S`/`-G` filter commits.
- A search that runs longer than 45 s is stopped with `GIT_OPERATION_FAILED` and a hint to
  narrow it with `path` or `branch`.

`get_blame` answers "who changed these lines, and why" in one call:

```text
main/mcp/tools/history.js on disk, lines 90-144: 18 runs from 2 commits
90-92 3a759009262c
93-104 d9a1d5ff7cac
…
commits:
3a759009262c 2026-10-06 ktarasenko: feat(mcp): fewer tokens — text answers, every change in one call, …
d9a1d5ff7cac 2026-10-04 ktarasenko: feat(mcp): read-only MCP server for AI agents, toolbar button and site page
```

By default it blames the file on disk, so the line numbers are the ones the agent read and
lines not committed yet are `uncommitted`. The code itself is left out unless `code: true`:
an agent has usually read the file already. Runs past about 60 KB end the answer with the
`startLine` to continue from. Files over 50 000 lines need `startLine`/`endLine`.

### Size limits

- `list_changes` and `get_commit` with diffs stay within `maxBytes` (60 000 by default); see
  above. A file is never cut in the middle.
- `search_history` and `get_blame` answers hold about 60 KB and say where to continue.
- `get_commit` lists up to 300 files; past that, `git show --name-status <hash>` lists the rest.
- Untracked files over 1 MB are described, not diffed.
- Any tool result over 120 000 characters is replaced by `OUTPUT_TOO_LARGE` with a hint.

### Errors

Errors are tool results with `isError: true` and this text:

```json
{ "error": { "code": "COMMIT_NOT_FOUND", "message": "No commit matches \"v9.9.9\".", "hint": "A short hash may be ambiguous: pass more of it, or a branch or tag name." } }
```

| Code | Meaning |
|---|---|
| `NO_REPOSITORY_OPEN` | No `repository` was passed and none is open in 🌱 Twig. |
| `REPOSITORY_NOT_FOUND` | `repository` matches no connected repository, or the repository is unavailable. |
| `FILE_NOT_FOUND` | (blame) The path is not in that version of the repository. |
| `COMMIT_NOT_FOUND` | No commit matches the hash (including an ambiguous short hash). |
| `REF_NOT_FOUND` | No branch, tag or revision has that name. |
| `INVALID_ARGUMENT` | An argument is missing, has the wrong type, is out of range, or is a path outside the repository. |
| `OUTPUT_TOO_LARGE` | The answer would be too large; ask for something smaller. |
| `GIT_OPERATION_FAILED` | Git failed, or a search or blame ran longer than 45 s. The exact command is in 🌱 Twig's console. |
| `TWIG_UNAVAILABLE` | Returned by the bridge: 🌱 Twig is not running, or the server is off. |

Unknown tools and methods are JSON-RPC errors (`-32602`, `-32601`).

## Example

> **You:** Look at my current changes and suggest how to split them into commits.

A well-behaved agent:

1. Calls `list_changes` with `diffs: true` (and `contextLines: 1` if it only needs the gist):
   the branch, every file and every small patch in one answer.
2. Runs the `git diff` that answer printed, only for the files it listed without a patch.
3. Calls `get_workspace_context` if it needs to know about a merge or rebase in progress.
4. Proposes a commit plan: which files and hunks go together, and a message for each.

The agent only *proposes* the plan. The MCP server can't stage or commit anything; you carry
out the plan in 🌱 Twig, where staging works by line and every step can be undone.

## Proposing a commit

Settings → AI agents (MCP) → **Allow agents to propose commits** (Off by default, and Off
even while the server is on; stored next to the server switch in `mcp.json`). While it is
off, `propose_commit` and `new_version` answer `WRITE_DISABLED`.

| Tool | Arguments | Returns |
|---|---|---|
| `propose_commit` | `message` (subject, blank line, body), `push` (false), `repository?` | Text: the outcome, or `waiting` with a `proposalId` if the person has not answered within ~45 s. |
| `new_version` | `bump` (`patch`), `message?`, `tag?`, `push` (true), `repository?` | The same, for a release: see [A new version](#a-new-version). |
| `await_commit` | `proposalId` | Waits up to ~45 s more and answers the same way. |

What happens:

1. 🌱 Twig reads what a commit of **everything** would take (like `git add -A`: modified, new
   and deleted files), refuses if a merge/rebase is in progress, there are conflicts, HEAD is
   detached or nothing changed, and brings its window forward with a dialog: repository,
   branch, where Commit & Push would push (the upstream, or `origin/<branch>` as a new
   upstream), every file with its line counts, the message (editable), and the exact
   commands. The button the agent asked for (`push`) is the default one.
2. **Cancel** (or Esc) changes nothing: `cancelled by user`.
3. **Commit** first checks that nothing moved since the proposal: HEAD, the branch, every
   changed path and each file's size, mode and modification time. If anything did, the
   dialog shows the new list and asks again — a tree nobody looked at is never committed.
4. Then, inside one Undo record: `git add --all`, your **pre-commit** and **commit-msg**
   automations (secret scan, message rules, your commands), the app's own commit
   (`git commit --file=- --cleanup=strip`, so Git hooks run too), then post-commit. If an
   automation blocks or `git commit` fails, the index is put back exactly as it was (it is
   saved with `git write-tree` first and restored with `git read-tree`) and the agent gets the
   reason. **Undo** in the toolbar takes the commit back like any other.
5. **Commit & Push** then runs the pre-push automations and the app's own push
   (`git push`, or `git push --set-upstream origin <branch>`).

**Version and tag.** Under the message the dialog has two switches, so the version and the
tag are chosen at commit time whichever agent proposed the commit — one that asked you about
the version, or one that never did.

- **Bump version** with patch, minor or major, showing "current → new". It is offered when
  the repository has a pre-commit pipeline with a **Bump version** action (Automations →
  template "Bump version", or `"type": "bumpVersion"` in `.twig/hooks.json`) — the switch then
  starts at the action's default — or, without one, for the root `package.json` if its
  `version` is X.Y.Z (the switch starts off). The bump happens with the commit, after every
  automation passed and right before `git commit`, so a refused commit never leaves a bumped
  file. It changes only the `version` string of the package.json the action names
  (`"target": "file"`, `"path"`) — or of every `modules/<dir>/package.json` with a change
  (`"target": "modules"`) — and, when present, the root `"version"` and
  `packages[""].version` of the package-lock.json next to it. The edit is textual, so
  formatting and line endings stay; npm never runs. With no package.json the version is the
  previous tag's, and the switch only changes the tag.
- **Tag this commit** with a name that follows the previous tag: the newest tag reachable from
  HEAD that has an X.Y.Z in it gives the pattern (`twig-v0.16.2` → `twig-v0.16.3`; a
  pre-release suffix such as `-rc.1` is not carried over), and with no such tag it is
  `v<version>`. The name follows the version until you type your own ("Follow the version"
  goes back). A tag that already exists or is not a valid name keeps the dialog open with the
  reason. The tag is lightweight (`git tag -- <name> HEAD`, right after the commit) and is its
  own Undo record: the first **Undo** deletes the tag, the next takes the commit back.
  **Commit & Push** pushes the branch and then the tag to the same remote
  (`git push --progress <remote> -- refs/tags/<name>`).

The bumped files go into the same commit. The commit panel offers the version choice too, when
a Bump version action applies.

### A new version

`new_version` is `propose_commit` for a release: the same dialog with **Bump version**
(the agent's `bump`, patch by default) and **Tag this commit** switched on, and Commit & Push
preselected. Without `message` the commit is `chore(release): <version>`, following the
version you pick until you edit it; `tag` suggests another tag name. A clean tree is fine:
the commit is the version bump alone, and with the bump switched off there is no commit at
all — Create tag / Tag & Push tag HEAD. The agent should not bump the files itself first.

```
committed 5d0c41e2a9b3 on main: chore(release): 1.5.0
version package.json: 1.4.0 → 1.5.0
tagged v1.5.0 at 5d0c41e2a9b3
pushed to origin/main
pushed tag v1.5.0 to origin
```

Answers, one line each:

```
committed 3a75900abcd1 on main: feat(app): add two (message edited in 🌱 Twig)
pushed to origin/main
```

or `cancelled by user`, `not committed: a pre-commit automation blocked it` followed by the
failing step and the end of its output, `not committed: Commit failed. …` followed by what the
Git hook printed, `push failed: <what Git said>`, `not tagged: …`, `tag push failed: …`, `superseded: a newer proposal replaced it`,
`expired: nobody confirmed it in 🌱 Twig` (after 30 minutes). One proposal is on screen at a
time. 🌱 Twig adds no trailer to the message.

Errors before anything is shown: `WRITE_DISABLED`, `NOTHING_TO_COMMIT`, `REPOSITORY_BUSY`
(operation in progress, conflicts, detached HEAD), `CONFIRMATION_UNAVAILABLE` (the window is
closed), `PROPOSAL_NOT_FOUND` (await_commit with an unknown or expired id). `new_version`
does not need changes, so it answers `NOTHING_TO_COMMIT` only on a branch with no commit.

Why two tools: MCP clients give up on a call after a while (Codex after 60 s by default), and a
person may think for minutes. `propose_commit` answers by itself within ~45 s either way.

## Security model

- **Off by default.** No socket exists until you turn the server on in Settings.
- **Local only.** 🌱 Twig listens on a Unix domain socket inside a folder that only your
  account can open (`0700`, socket `0600`), or a named pipe on Windows. There is no TCP port
  and no network listener. If the userData path is too long for a socket, 🌱 Twig uses a `0700`
  folder under your temp directory. It refuses to listen there if the folder belongs to anyone
  else or other users can open it.
- **Reads by itself, writes only through you.** Every tool but `propose_commit`,
  `new_version` and `await_commit` only reads and is marked `readOnlyHint: true`. Those three are marked
  `readOnlyHint: false`, are off until you allow them in Settings, and change nothing until
  you confirm in 🌱 Twig's window. There is no `run_command`, `run_git`, `shell` or `execute`.
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
  `initialize` when it attaches mid-session. The one thing it adds is its own working
  directory, in `initialize`'s `_meta` (`app.nodex.twig/cwd`), so tools default to the
  agent's repository. A bridge copied by an older version does not add it; 🌱 Twig rewrites
  the copy every time the server starts.
- `main/mcp/tools/`: `workspace.js`, `changes.js`, `show.js` (`get_commit`), `search.js`,
  `blame.js`, `ui.js` and `commit.js` (the proposals). The readers contain no Git parsing;
  they call `loadWorktree`, `loadWorktreeDiffs`, `loadUntrackedDiff`, `loadWorktreeNumstat`,
  `loadCommit`, `loadCommitNumstat`, `loadCommitDiffs`, `resolveRevision`,
  `loadOperationState`, `searchCommits` and `loadBlameRange`. `main/mcp/file-patches.js` is
  what `list_changes` and `get_commit` share: which files to leave out, the budget, and the
  git command a left-out file is read with.
- `main/mcp/context.js`: resolves the repository, tags journal entries `MCP:` and sets the
  read environment, and matches the client's working directory to a connected repository.
  `main/mcp/serialize.js` holds the text shapes (file lines, hunks, commit lines).
  `main/mcp/ui-context.js` validates the window's reports.
- `main/mcp/service.js` (lifecycle, no Electron imports), `main/mcp-ipc.js` (Settings
  channels and the UI report) and `main/mcp-store.js` (`mcp.json`, the on/off choice).

## Testing locally

```sh
node scripts/checks/mcp.mjs     # part of npm test: tools on real repositories, read-only, transport, bridge
node scripts/checks/mcp-commit.mjs   # part of npm test: propose_commit and new_version on real Git — cancel, stale tree, automations, hooks, Undo, tags, push
npm run build && node scripts/mcp-smoke.mjs   # part of npm run test:smoke: Settings, a real bridge on the app executable
```

`node scripts/mcp-tokens.mjs [--count] [--only=changes|search]` measures what the same
questions cost through `git` and through 🌱 Twig; the texts stay in `artifacts/mcp-tokens/`.

To try it by hand, run 🌱 Twig from source (`npm run dev`), turn the server on, then use the
MCP Inspector with the command and arguments from Settings:

```sh
ELECTRON_RUN_AS_NODE=1 npx @modelcontextprotocol/inspector "<command from Settings>" "<bridge path from Settings>"
```

## Limitations

- The only write is a commit of everything (plus push) that you confirm. There is no partial
  commit (`paths`), no staging of hunks, no branch, checkout or merge tool.
- The only transport is local stdio through the socket bridge. HTTP is not offered.
- There is no hunk *selection* in 🌱 Twig to report, and no branch selection.
- `get_ui_context` reports the history workspace: the selected commit(s), compare range,
  open file diff, file history, blame and conflict file. File selection inside the staging
  screen is not reported.
- Commit diffs are against the first parent, with a context of 3 lines.
- Verified live on macOS arm64, running from source. For a packaged macOS build, only the
  bridge running on the packaged executable was checked. The Windows named pipe, AppImage
  (`$APPIMAGE` as the command) and deb paths follow the same code but have not been run.

## Next phase (not implemented)

`propose_commit` is the first write tool. Others, such as `stage_hunk`, `unstage_hunk`,
`create_branch`, `checkout` and `merge`, would need the same:

- a separate capability that the person grants in Settings, off even when reading is on;
- a confirmation in 🌱 Twig's window for each mutation, showing the exact command, like the
  app's other confirmation dialogs;
- the existing Undo service, so an agent's action can be undone like the person's own;
- hunks named by their content, so `stage_hunk` applies exactly the hunk the agent read.
  Staging already works this way: main re-reads the diff and refuses if it changed.
