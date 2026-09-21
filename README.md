# 🌱 Twig

A standalone desktop Git client for macOS, Windows and Linux, built on Electron +
React 18 + Vite (plain JavaScript ESM, Node 20). The workspace puts the commit
history in the center, repository navigation on the left, commit details on the
right, and a command console below — everything the app runs against Git is
visible there, exactly as it was invoked.

**Current version: 0.9.1.** Released 2026-09-21 — what appeared in each release
is listed in [CHANGELOG.md](CHANGELOG.md). This repository was split out of the private
`nodes-managers` monorepo (`modules/git_desk`) with `git subtree split`; the
M0…M6 history is preserved. `PROMPT.md` is the full specification and `CLAUDE.md`
records the current handoff state.

**Website:** <https://kitarasenka.github.io/twig/> — overview and downloads.

![The 🌱 Twig workspace: a real Git sandbox with commit graph in the center, refs
on the left, commit detail with local marks on the right, and the command
console below.](site/assets/workspace.png)

## What it does

- **Real commit graph.** A virtualized, paginated view over
  `git log --all --topo-order` with a hand-rolled lane layout — no graph library.
  Branch and tag badges, author initials in each node, day separators, and an
  optional "commit age" color ramp instead of branch-lane colors. Column widths
  (branch / graph / message / author / date) are draggable and persisted.
- **Sidebar** with LOCAL / REMOTE / TAGS read from `git for-each-ref`,
  ahead/behind badges, and branch names grouped into folders by `/`. One search
  field filters refs and, from two characters, searches commit messages and
  hashes across the whole history.
- **Commit panel** with the full message, author card, parents (click to jump),
  changed files, an inline diff with intra-line highlighting of the parts of a
  line that actually changed, local color "marks" with notes, and links to the
  commit and the author's commits on GitHub / GitLab / Bitbucket.
- **Working tree.** Staged / unstaged / untracked lists, a diff where individual
  lines and hunks can be staged, "stage all" per section, and a commit box that
  validates the message and can amend the last commit.
- **History operations.** A context menu on every commit: branch, tag, checkout,
  merge (with or without fast-forward), rebase, interactive rebase, cherry-pick,
  revert, reset in all three modes, reword, squash a multi-selection, plus the
  full set of ref operations (rename, set upstream, publish, delete locally and
  on the remote). Only what applies to that commit is offered; the rest is shown
  disabled with the reason.
- **Interactive rebase editor** — reorder by drag, buttons or Alt+Arrow, choose
  pick / reword / edit / squash / fixup / drop. Git performs the rebase; Twig
  supplies the plan as its sequence editor.
- **Three-way conflict editor** — ours, base and theirs beside an editable
  result, taking whole sides or individual lines in either order, with its own
  undo/redo and a warning if conflict markers are left behind.
- **Drag and drop** branches from the sidebar or graph onto branches and commits
  to open a merge / rebase / pull / push / cherry-pick / revert / compare menu.
- **Blame, blame history and reverse blame** for any committed version of a file,
  with "blame before this change" stepping back through the history.
- **File history** — every commit that touched a file, following renames, with a
  per-commit diff of just that file.
- **BugHunter** — a guided `git bisect` with a range picker, remaining-step
  estimate and a banner showing the revision under test.
- **Branches and tags** and **Stashes** screens — checkout, rename, upstream,
  publish, delete; stash list, files, diff, apply / pop / branch / drop.
- **Visual hook automations** (M6) — a "trigger → conditions → actions → result"
  pipeline that runs on Git operations performed inside Twig (commit, push,
  merge, rebase, checkout…). Actions are commands, scripts or built-in checks
  (message format, changed files, secret scan). Repository-provided config
  (`.twig/hooks.json`) is treated as untrusted data and never runs until a
  person enables it. Pipelines can block a commit or push; a one-time bypass is
  logged.
- **Git profile, remotes, repository list and clone** in Settings — edit the
  five profile keys locally or globally, manage remotes, clone into a fresh
  folder with live output and cancellation.
- **Command console** with the exact argv, cwd, timing, exit code and streamed
  output of every Git run, plus search and an "all / my actions" filter. The
  input line accepts **read-only Git only** — a subcommand allowlist, no shell.
- **Auto-refresh.** A commit, checkout, fetch or merge run in a terminal shows up
  on its own — `main` watches the active repository's git directory with a single
  `fs.watch` (event-driven, no polling) and the workspace reloads. Regaining
  focus after a real absence is a backstop; the Refresh button stays for the rest.
- **Demo workspace.** The `workspace-demo` tab is a real Git repository seeded in
  `userData` with a local bare remote — not a mock. Every operation works there.
  Settings → *Reset demo workspace* re-seeds it.
- System / dark / light appearance applied before React loads, bundled Fira Sans
  / Fira Code, Lucide icons, full keyboard navigation.

Shortcuts use Cmd on macOS and Ctrl elsewhere: `J` console, `F` filter,
`T` new tab, `W` close tab, `,` settings. Tab / Shift+Tab moves between controls,
arrows / Home / End move in the history, Escape closes dialogs.

## Run locally

Requires Node **20.19+ (Node 20 LTS)** and npm. From the repository root:

```sh
npm ci
npm run dev
```

`dev` builds the isolated preload, starts Vite at `127.0.0.1:5188`, then launches
Electron. Closing Electron (Quit on macOS) stops Vite. Renderer changes reload
live; restart `dev` after changing `main/` or `preload/` code.

For the production renderer:

```sh
npm run build
npm start
```

The app needs no server, token or `.env` file. `nodexInstall: false` — it never
runs under nodex or PM2.

## Verify

```sh
npm test           # ESLint + ~30 Node checks (parsers, argv builders, real-Git checks)
npm run test:smoke # builds and launches real Electron sessions; needs a desktop session
```

Most checks spawn no Git. Several deliberately do — `patch-builder.mjs`,
`stage.mjs`, `stash.mjs`, `bisect.mjs`, `blame.mjs`, `history-ops-live.mjs`,
`automation-run.mjs`, `sandbox.mjs` — building throwaway repositories. The only
real proof that a partial-staging patch is correct is that `git apply --cached`
accepts it and the index holds exactly the selected lines; the only real proof
that an interactive rebase works is that Git replayed the supplied plan and not
its own default.

`npm run test:smoke` runs independent Electron scripts, each with its own
temporary profile: the M0/M1 shell, real-repository history and pagination, blame
navigation, line-level staging and push to a local bare repo, the context menu
and conflict editor, branch drag-and-drop, the Branches / Stashes / BugHunter
screens, Git profile and repository management, hook automations, and the demo
sandbox reset. Screenshots land in the ignored `artifacts/`.

## Packaging and the landing site

```sh
npm run pack:mac    # dmg installers (arm64 + x64)
npm run pack:win    # nsis installer (x64)
npm run pack:linux  # deb installer for Debian / Ubuntu (x64)
```

Builds write into `release/` without publishing. Install Twig by dragging the
app from the macOS DMG into Applications, running the Windows installer, or
installing the Linux DEB package. Settings and app state use the standard
per-user OS directory.

No paid Apple Developer ID or notarization is planned for v1: the macOS build
is ad-hoc signed (no identity, just enough for arm64 to accept the code at
all — fully unsigned code is refused outright as "damaged" on Apple Silicon,
not just warned about) so Gatekeeper falls back to its normal "unidentified
developer" prompt. Open it via right-click → Open, or allow it in System
Settings → Privacy & Security — only for a build whose origin you trust.

The landing page lives in `site/`. `npm run build:site` writes `site/dist/`,
`npm run preview:site` serves it at `http://127.0.0.1:5190`. A GitHub Actions
workflow (`.github/workflows/site.yml`) deploys it to GitHub Pages on push to
`main`; installer binaries are attached to a `twig-v<version>` GitHub Release
rather than hosted on the site. See [site/README.md](site/README.md).

## Milestones

- **M0–M4** — shell, Git executor and journal, real commit graph and diff panel,
  line-level staging / commit / stash / sync, and the full history-operations set
  (menu, interactive rebase, conflict editor, operation banner). Done.
- **M5** — in progress. Git profile, remotes, repository list and clone are done;
  SSH, application Undo/Redo (§8.1), installers and final validation on three
  operating systems remain.
- **M6** — visual hook automations. Step 1 (engine and UI for operations run
  inside Twig) is done; installing dispatchers into `.git/hooks` to cover Git
  from an external terminal is step 2 and not done.

Electron is pinned to **41.7.1** — newer installers require Node 22.12, which
conflicts with the mandated Node 20. Reassess before shipping installers.

## Security boundaries

The renderer is sandboxed, context-isolated and has no Node integration. The
preload exposes only explicit app / repository / history / console APIs, with
sender / frame / argument validation in main; a repository id only ever resolves
to one already in the persisted, checked repository list — never to a path the
renderer chose.

System Git runs only through the single logged `spawn` executor
(`main/git/exec.js`). The one sanctioned exception to "Git only" is user
automations, which run non-Git processes through `main/automation/exec.js` —
always `shell: false`, logged, with a timeout and cancellation. Arbitrary
commands never cross IPC; the console input line runs a read-only subcommand
allowlist in main and rejects anything else.

Staging a line selection sends indices and the digest of the diff the renderer
was shown, never patch text — main re-reads the diff and refuses the apply if the
file changed. Commit messages and patches reach Git on stdin, so they never touch
a temp file or the journal. Branch and tag names are checked against
`git-check-ref-format` and passed after `--`, so a name like `--force` stays a
name. Credential-bearing and unknown-transport remote URLs are refused and hidden
from the journal.

External HTTP(S) links (and bare `mailto:`) open in the system browser; window
navigation, embedded webviews, permission requests and renderer network requests
are blocked. No telemetry, remote fonts or credential storage. The only request
the app makes for itself is the manual update check in Settings: one call to the
GitHub Releases API when you press the button, compared against the running
version — nothing is checked in the background, downloaded or installed. Colors
come only from `design/TOKENS.md`.

## License

Copyright (c) 2026 Kiryl Tarasenka.

🌱 Twig is distributed under the Functional Source License, Version 1.1, with an
Apache 2.0 future license (`FSL-1.1-ALv2`) — see [LICENSE.md](LICENSE.md). You
may use, modify and redistribute it for any purpose that is not a competing
commercial product or service, and every version becomes Apache 2.0 two years
after it is made available.

That license applies to the commit that introduced it and everything published
after it. Releases up to and including 0.8.5 were published with no license file
and no grant of any kind; [NOTICE.md](NOTICE.md) spells this out. Contributions
are accepted under the [CLA](CLA.md).
