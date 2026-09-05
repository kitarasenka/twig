# 🌱Twig

A standalone desktop Git client for macOS, Windows and Linux. Its workspace puts
commit history in the center, repository navigation on the left, details on the
right, and the command console below.

**Current version: 0.1.3 — M3.** On top of the real commit graph from M2, Twig
now changes repositories: stage and unstage whole files or individual lines,
commit from the working tree screen, stash and pop, and pull or push with
divergence badges on the toolbar. History rewriting (merge, cherry-pick,
revert, reset, rebase) and the conflict editor are still to come in M4.

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

Most checks spawn no Git at all. Two deliberately do: `patch-builder.mjs` and
`stage.mjs` build throwaway repositories, because the only real proof that a
partial-staging patch is correct is that `git apply --cached` accepts it and
the index ends up holding exactly the selected lines.

`npm run test:smoke` runs three independent Electron sessions, each with its
own temporary profile: `scripts/smoke.mjs` covers the M0/M1 shell (sandboxing,
the exact preload surface, demo history, console, themes);
`scripts/history-smoke.mjs` creates a real repository (root commit, a branch,
a merge, 259 linear commits, an annotated tag) and drives pagination, keyboard
navigation and the file diff; `scripts/worktree-smoke.mjs` stages individual
lines, unstages, commits, and pushes to a local bare repository. All write
screenshots into ignored `artifacts/`.

## Next milestones and packaging

M4 adds history-mutating operations (merge, cherry-pick, revert, reset,
interactive rebase, conflict editor). M5 adds the user zone (profile, SSH,
remotes), Undo/Redo and packaging. `PROMPT.md` is the full specification;
`CLAUDE.md` records the handoff state.

`electron-builder` is installed for the fixed stack. Installers are **not built
in M5**. M5 targets macOS dmg (x64 + arm64), Windows nsis (x64), and Linux AppImage
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
