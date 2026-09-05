# Git Desk

A standalone desktop Git client for macOS, Windows and Linux. Its workspace puts
commit history in the center, repository navigation on the left, details on the
right, and the command console below.

**Current version: 0.1.0 — M0 layout preview.** This is a runnable desktop shell,
not yet a working Git client. The sample repository is fictional. Opening,
cloning and Git operations are disabled with explanations; no Git commands run.

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
- Tabs retain the demo's selection, filter and scroll while switching.
- Closable details with a keyboard-accessible width slider, collapsible sidebar.
- Expandable empty console: no invented commands or output.
- System/dark/light appearance with persistent preference and bundled fonts.

Shortcuts use Cmd on macOS and Ctrl elsewhere: `J` console, `F` filter,
`B` sidebar, `T` new tab, `W` close tab, `,` settings. Use Tab / Shift+Tab to
navigate controls, arrows / Home / End in history, and Escape to close dialogs.

## Verify

```sh
npm test          # ESLint + Node self-checks, no network or real repositories
npm run test:smoke # builds and launches real Electron; requires a desktop session
node scripts/smoke.mjs --dev # same check through the local Vite server
```

The smoke check uses a temporary profile, verifies renderer isolation, keyboard
navigation, tabs, search, themes and the console, and writes screenshots into
ignored `artifacts/`. It does not open or modify a Git repository.

## Next milestones and packaging

M1 adds the sole Git executor, startup Git detection, repository opening and the
persistent live command journal. M2 replaces sample history with paginated,
virtualized Git history and a tested lane-layout algorithm. M3–M5 add mutations,
conflict editing, profile/SSH and operation Undo/Redo. `PROMPT.md` is the full
specification; `CLAUDE.md` records the handoff state.

`electron-builder` is installed for the fixed stack. Installers are **not built
in M0**. M5 targets macOS dmg (x64 + arm64), Windows nsis (x64), and Linux AppImage
+ deb (x64), with native-platform validation. No signing or notarization is
planned: macOS Gatekeeper will warn about the unsigned app. Only open a build
whose origin you trust, using macOS's explicit Open/Privacy & Security flow.

Electron 41.7.1 is pinned because newer npm installers require Node 22.12;
the project mandates Node 20. electron-builder 26.0.12 likewise keeps its
build dependencies compatible with Node 20. Reassess this compatibility constraint before
shipping installers. Vite 8 requires at least Node 20.19.0.

## Security boundaries

The renderer is sandboxed, context-isolated and has no Node integration. The
preload exposes only `getAppInfo()`, with sender/frame/argument validation in
main. Its ESM source is bundled into a sandbox-compatible CommonJS artifact.
External HTTP(S) links open in the system browser; window navigation, embedded
webviews, permission requests and renderer network requests are blocked.
Only the local Vite origin is allowed in development. Production CSP blocks
inline scripts; Vite development allows its React-refresh preamble.

No telemetry, updater, remote fonts or credential storage. The application will
use system Git through a single logged `spawn` executor in M1.
