# Developing 🌱 Twig

`PROMPT.md` is the full specification and `CLAUDE.md` records the current handoff
state. This repository was split out of the private `nodes-managers` monorepo
(`modules/git_desk`) with `git subtree split`; the M0…M6 history is preserved.

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

## Screenshots

The screenshots are regenerated from the real app by `npm run shots:site`
(`scripts/site-shots.mjs`): it seeds the demo sandbox
in a throwaway profile, drives the UI into each state and writes PNGs to the
ignored `artifacts/site-shots/`, plus WebP copies into `site/assets/shots/`
when `cwebp` is installed. The README and the landing page both use those files.

## Packaging and the landing site

```sh
npm run pack:mac    # dmg installers (arm64 + x64)
npm run pack:win    # nsis installer (x64)
npm run pack:linux  # deb for Debian / Ubuntu and an AppImage (x64)
```

Builds write into `release/` without publishing. Install Twig by dragging the
app from the macOS DMG into Applications, running the Windows installer,
installing the Linux DEB package, or making the AppImage executable
(`chmod +x`) and running it. Settings and app state use the standard per-user OS
directory. Pushing a `twig-v<version>` tag runs `.github/workflows/release.yml`,
which builds all of them and attaches them to a GitHub Release with the
matching section of `CHANGELOG.md` as its notes.

On Linux the Electron binary is wrapped by a small launcher that points
fontconfig at its own cache directory, so the app starts on hosts whose system
fontconfig is newer than the one bundled with Electron. Set
`TWIG_SYSTEM_FONTCONFIG=1` to skip that.

The macOS release workflow supports Developer ID signing and notarization when
its Apple credentials are configured. The build then enables Hardened Runtime,
signs the app, notarizes it, staples Apple's ticket, does the same for the DMG
(`scripts/notarize-dmg.mjs` — a downloaded disk image is assessed on its own),
and checks both with `codesign`, `stapler validate` and `spctl` before
uploading. Until those
secrets are configured, macOS builds keep the ad-hoc signature so Apple
Silicon can run them; Gatekeeper still shows the "unidentified developer"
prompt. Open such a build via right-click → Open, or allow it in System
Settings → Privacy & Security, only if you trust its origin.

Setting up signing (Apple Developer Program membership required):

1. **Developer ID Application certificate** (Account Holder only). Without
   Xcode: `openssl genrsa -out developer-id.key 2048`, then
   `openssl req -new -key developer-id.key -out developer-id.csr -subj "/CN=<name>"`;
   upload the CSR at developer.apple.com → Certificates → + → *Developer ID
   Application* (G2 Sub-CA) and download the `.cer`. Bundle it with Apple's
   intermediate (`https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer`)
   into `twig-developer-id.p12`:
   `openssl pkcs12 -export -inkey developer-id.key -in <cert.pem> -certfile <g2ca.pem> -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 -out twig-developer-id.p12`
   (the legacy PBE keeps `security import` happy). Keep the key and the
   `.p12` outside the repository.
2. **App Store Connect API key** for notarization: App Store Connect → Users
   and Access → Integrations → App Store Connect API → Team Keys → +, access
   *Developer*. Download `AuthKey_<KEYID>.p8` (only once), note the Key ID and
   the Issuer ID shown above the list.
3. **Repository secrets** (the values never appear in the shell history):

   ```sh
   base64 -i twig-developer-id.p12 | gh secret set MAC_CSC_LINK
   gh secret set MAC_CSC_KEY_PASSWORD            # prompts for the .p12 password
   gh secret set APPLE_API_KEY < AuthKey_<KEYID>.p8
   gh secret set APPLE_API_KEY_ID --body <KEYID>
   gh secret set APPLE_API_ISSUER --body <issuer-uuid>
   ```

   `APPLE_API_KEY` holds the text of the `.p8` file; the workflow writes it to
   a temporary file because `notarytool` takes a path. Set all five or none —
   a partial set fails the build instead of shipping an unsigned DMG silently.

The next `twig-v*` tag then produces signed, notarized DMGs. The workflow puts
the identity into its own keychain with `scripts/mac-signing-keychain.sh` and
hands electron-builder `CSC_NAME` + `CSC_KEYCHAIN`: electron-builder 26.0.12's
own `CSC_LINK` import unlocks its keychain with the wrong password and fails.
Locally the same works:

```sh
NAME=$(P12_PASSWORD=… scripts/mac-signing-keychain.sh create twig-developer-id.p12 /tmp/twig.keychain-db)
CSC_NAME="$NAME" CSC_KEYCHAIN=/tmp/twig.keychain-db \
  APPLE_API_KEY=$PWD/AuthKey_<KEYID>.p8 APPLE_API_KEY_ID=<KEYID> APPLE_API_ISSUER=<issuer> \
  npm run pack:mac
scripts/mac-signing-keychain.sh delete /tmp/twig.keychain-db
```

The landing page lives in `site/`. `npm run build:site` writes `site/dist/`,
`npm run preview:site` serves it at `http://127.0.0.1:5190`. A GitHub Actions
workflow (`.github/workflows/site.yml`) deploys it to GitHub Pages on push to
`main`; installer binaries are attached to a `twig-v<version>` GitHub Release
rather than hosted on the site. See [site/README.md](../site/README.md).

## Milestones

- **M0–M4** — shell, Git executor and journal, real commit graph and diff panel,
  line-level staging / commit / stash / sync, and the full history-operations set
  (menu, interactive rebase, conflict editor, operation banner). Done.
- **M5** — Git profile, SSH keys, application Undo/Redo (§8.1), remotes,
  repository list, clone and installers for all three systems are done. What
  remains is hands-on validation of the Windows and Linux builds on real
  machines — they are built by CI but have not been run here.
- **M6** — visual hook automations. Step 1 (engine and UI for operations run
  inside Twig) is done; installing dispatchers into `.git/hooks` to cover Git
  from an external terminal is step 2 and not done.

Everything after the milestones — the uncommitted-changes panel, line numbers,
wrapped ref badges, the closable demo tab, the My / Full History console and the
rest — is listed per release in [CHANGELOG.md](../CHANGELOG.md).

Electron is pinned to **41.7.1** — newer versions require Node 22.12, which
conflicts with the mandated Node 20. Do not bump it through a `^` range.
