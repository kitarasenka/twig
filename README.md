# 🌱 Twig

A standalone desktop Git client for macOS, Windows and Linux. Its workspace puts
commit history in the center, repository navigation on the left, details on the
right, and the command console below.

**Current version: 0.2.0 — M4.** 🌱 Twig now rewrites history as well as recording
it: a context menu on every commit, merge, cherry-pick, revert, reset,
interactive rebase driven by Git itself, a three-way conflict editor, and a
banner for an operation Git stopped in the middle of. Destructive commands ask
first, showing the exact command and what it destroys.

M5 is in progress. The Git profile button now edits name, email, editor, pull
strategy and initial branch for this repository or globally. Each field has an
explicit Save/Remove action, shows its effective value, and detects stale edits.
Settings now also opens repository and remote management. Add or remove a
repository entry (its files stay on disk), add/edit/remove remotes, or fetch and
prune explicitly. The new-repository tab can clone into a fresh folder with live
output and cancellation. SSH, application Undo/Redo and installers are still
pending. The M2–M4 requirements audit is in `tasks/M4-HISTORY-OPS-RESULT.md`.

Cloning never overwrites an existing folder. On failure or cancellation, only
an empty destination is removed; remaining files are kept for inspection.
Remote editing changes the primary fetch URL; additional fetch URLs and explicit
push URLs are displayed read-only. Existing credential-bearing remote addresses
are hidden in command-log output; new addresses must use a credential helper.

## Run locally

Use Node **20.19+ within Node 20 LTS** and npm. From the repository root:

```sh
cd modules/git_desk
npm ci
npm run dev
```

`dev` builds the isolated preload, starts Vite at `127.0.0.1:5188`, then launches
Electron. Closing Electron (Quit on macOS) stops Vite. Renderer changes reload
live; restart `dev` after changing main or preload code.

For the production renderer:

```sh
npm run build
npm start
```

This module is deliberately excluded from `npm run install:modules` using
`nodexInstall: false`. It has no `nodex.json` and never runs under nodex or PM2.
The app does not require the monorepo server, a token, or an `.env` file.

## Available in the preview

- Desktop shell with repository tabs, action toolbar and collapsible sections.
- Clearly labeled demo history with a static curved SVG illustration, selection,
  arrow-key navigation, filtering, commit details and parent navigation.
- For an opened repository: a real, virtualized, paginated commit graph
  (`git log --all --topo-order`) with a hand-rolled lane layout — no graph
  library — branch/tag badges, relative dates and day separators.
- Sidebar with LOCAL/REMOTE/TAGS sections read from `git for-each-ref`,
  ahead/behind badges, and branch names grouped into folders by `/`.
- Right-hand commit panel: full message, author, parents (click to jump),
  changed-file list and a read-only diff view; Shift-click two commits to
  compare their range instead of a single commit.
- An "Uncommitted changes" row at the top of the graph opens the working tree:
  staged, unstaged and untracked lists, a diff where individual lines and
  hunks can be picked, and a commit box that checks the message.
- Toolbar Pull and Push carry incoming/outgoing badges read from the last
  fetch, plus Stash and Pop. A running network operation can be cancelled;
  only `--force-with-lease` is ever offered, never a plain force push.
- A context menu on any commit — right-click, or Shift+F10 from the keyboard:
  create a branch or tag, check out, merge with or without a fast-forward,
  rebase, cherry-pick, revert, reset in all three modes, copy the SHA or the
  message. Only what applies to that commit is offered.
- An interactive rebase editor: reorder by dragging, by buttons or by
  Alt+Arrow, and choose pick, reword, edit, squash, fixup or drop per commit.
  Git performs the rebase — 🌱 Twig supplies the plan as its sequence editor.
- A three-way conflict editor: ours, base and theirs beside an editable
  result, taking whole sides or individual lines in either order, with its own
  undo and redo and a warning if conflict markers are left behind.
- A banner above the history whenever a merge, cherry-pick, revert or rebase
  is unfinished, with the conflicted files and Continue, Skip and Abort.
- Tabs retain the demo's and each repository's selection, filter and scroll
  while switching.
- Closable details with a keyboard-accessible width slider, collapsible sidebar.
- Native local-repository picker and persisted repository list; unavailable paths
  are identified on the next launch without touching their contents.
- Startup Git detection and a persistent live command console with exact argv,
  cwd, timing, exit code, output, search, filtering and copying.
- System/dark/light appearance with persistent preference and bundled fonts.

Shortcuts use Cmd on macOS and Ctrl elsewhere: `J` console, `F` filter,
`B` sidebar, `T` new tab, `W` close tab, `,` settings. Use Tab / Shift+Tab to
navigate controls, arrows / Home / End in history, and Escape to close dialogs.

## Verify

```sh
npm test          # ESLint + parser/executor/graph/staging checks
npm run test:smoke # builds and launches three real Electron sessions; requires a desktop session
node scripts/smoke.mjs --dev # same M0/M1 check through the local Vite server
```

Most checks spawn no Git at all. Three deliberately do: `patch-builder.mjs`,
`stage.mjs` and `history-ops-live.mjs` build throwaway repositories. The only
real proof that a partial-staging patch is correct is that `git apply --cached`
accepts it and the index ends up holding exactly the selected lines; the only
real proof that an interactive rebase works is that Git replayed the supplied
plan — reordered, reworded, squashed and dropped — and not its own default.

`npm run test:smoke` runs six independent Electron scripts, each with its
own temporary profile: `scripts/smoke.mjs` covers the M0/M1 shell (sandboxing,
the exact preload surface, demo history, console, themes);
`scripts/history-smoke.mjs` creates a real repository (root commit, a branch,
a merge, 259 linear commits, an annotated tag) and drives pagination, keyboard
navigation and the file diff; `scripts/worktree-smoke.mjs` stages individual
lines, unstages, commits, and pushes to a local bare repository;
`scripts/ops-smoke.mjs` opens the context menu with mouse and keyboard, runs a
merge into a conflict, resolves it line by line, confirms a `reset --hard`
dialog without accepting it, and drives an interactive rebase. All write
screenshots into ignored `artifacts/`. `scripts/profile-smoke.mjs` checks global
and local profile edits, inheritance, stale-value refusal, IPC and both themes;
its global Git config lives in a temporary directory. `npm test` also runs
`checks/profile.mjs` against isolated Git configuration.
`checks/repositories.mjs` verifies remotes, cloning, cancellation, list persistence
and disk preservation. `repositories-smoke.mjs` exercises the corresponding UI,
history after clone/fetch, both themes and persistence after an Electron restart.

## Next milestones and packaging

The 🌱 Twig landing page now lives in `site/`. Run `npm run build:site`, then
`npm run preview:site` to open it at `http://127.0.0.1:5190`. Upload `site/dist/`
to a static host and place installer files in its `downloads/` directory.
See [site/README.md](site/README.md) for deployment and download filenames.

Packaging commands are now available: `npm run pack:mac`, `npm run pack:win`,
and `npm run pack:linux` on the respective platforms. They build the app and
write installers into `release/` without publishing. Installer names and site
links share the `package.json` electron-builder configuration. Native installer
builds and execution still need platform validation; configuration alone does
not establish that the packages work.

M5 has profile and repository management. SSH, Undo/Redo and packaging
remain. `PROMPT.md` is the full specification;
`CLAUDE.md` records the handoff state.

`electron-builder` is installed for the fixed stack. Installers are **not built
yet**. M5 targets macOS dmg (x64 + arm64), Windows nsis (x64), and Linux AppImage
+ deb (x64), with native-platform validation. No signing or notarization is
planned: macOS Gatekeeper will warn about the unsigned app. Only open a build
whose origin you trust, using macOS's explicit Open/Privacy & Security flow.

Electron 41.7.1 is pinned because newer npm installers require Node 22.12;
the project mandates Node 20. electron-builder 26.0.12 likewise keeps its
build dependencies compatible with Node 20. Reassess this compatibility constraint before
shipping installers. Vite 8 requires at least Node 20.19.0.

## Security boundaries

The renderer is sandboxed, context-isolated and has no Node integration. The
preload exposes only explicit app, repository, history and console APIs, with
sender/frame/argument validation in main; a repository id never resolves to a
path the renderer chose itself, only to one already in the persisted, checked
repository list. Its ESM source is bundled into a sandbox-compatible CommonJS
artifact.
External HTTP(S) links open in the system browser; window navigation, embedded
webviews, permission requests and renderer network requests are blocked.
Only the local Vite origin is allowed in development. Production CSP blocks
inline scripts; Vite development allows its React-refresh preamble.

No telemetry, updater, remote fonts or credential storage. System Git runs only
through the single logged `spawn` executor; arbitrary commands never cross IPC.
Staging a line selection sends indices and the digest of the diff the renderer
was shown, never patch text: main re-reads the diff itself and refuses the
apply if the file changed in between. Commit messages and patches reach Git on
stdin, so they are never written to a temp file and never land in the journal.
Branch and tag names are checked against git-check-ref-format and passed after
`--`, so a name like `--force` stays a name. Input that is not valid Git is
refused at the channel rather than answered with a failure. A rebase plan is
written under the app's own state directory, never inside the repository, and
is deleted as soon as the operation ends.
