# 🌱 Twig — design tokens

M0, 2026-09-05. Source of truth: CSS below is copied exactly to
`renderer/src/ui/tokens.css`; `npm test` checks parity and text contrast.

## Skill decisions

Commit age ramp, 2026-09-06: five stops (`--age-fresh` … `--age-root`) paint the
graph lanes, the Date column and the committed date in the commit panel from
green new work down to brown roots. It is a Settings choice, stored next to the
theme as `twig:commit-colors`, and the ramp is the default. The scale is
absolute — today, this week, this month, this year, older — not relative to the
loaded page: a relative scale would repaint rows already on screen the moment an
older page arrives. Dark mode keeps the logo's light hues (spring green through
clay); light mode inverts to forest, olive and bark. All ten colours pass 4.5:1
against every surface in `foundation.mjs`, because the ramp also colours text.
Colour is never the only carrier: the same row prints "45 days ago" next to the
lane, and the Settings legend names every stop. No skill rerun for this one — it
adds tokens and a settings row, not a screen.

Intra-line diff, 2026-09-08: in a line a hunk removes and re-adds, only the
changed characters carry a mark — added get a light `color-mix(--accent 26%)`
plus a 2px underline, removed get `color-mix(--danger 34%)` plus a strike, both
on `var(--text)`; the tint stays subtle so text keeps 4.5:1 and the decoration
does the heavy lifting. Colour is never the
only signal: the underline and strike say add vs remove on their own, and the
line still sits on the existing `.diff-added` / `.diff-deleted` background. The
diff runs on tokens (words, whitespace, single punctuation), not raw characters,
so an inserted span stays whole instead of scattering shared letters; a rewrite
(under 20% shared characters) or a very long line falls back to whole-line
colouring. No new tokens — the mix
follows the commit-mark precedent — and no new screen, so no full skill rerun,
same call as the age ramp above.

Changed-file status badge, 2026-09-08: the single status letter before a changed
file's path (commit panel, working tree, stash files) is now a filled rounded
square — the letter in `var(--bg)` on a `--mark-*` fill, one colour per status:
added / untracked `--mark-green`, modified `--mark-amber`, deleted / conflict
`--mark-red`, renamed / copied `--mark-blue`, type-change `--mark-violet`,
anything else `--mark-slate`. Reuses the six commit-mark tokens exactly as the
graph nodes do (fill in the mark colour, glyph in `--bg`), so no new tokens.
Colour is never the only carrier: the letter still spells the status and every
badge carries a `title` / `aria-label` ("Added", "Modified", …). The check holds
`--bg` on each mark fill to the 3:1 a UI component needs — the same bar
`foundation.mjs` holds the marks to — since the glyph is a bold single-letter
badge with a redundant text label, not body copy. No new screen, no full skill
rerun, same call as the age ramp and intra-line diff above.

BugHunter, 2026-09-06: reran design-system for guided desktop debugging and
React semantic controls. Retained 🌱 Twig's tokens, local fonts and density.
Adopted three named phases, an explicit remaining-test estimate, visible
instructions, descriptive answer/skip/return buttons and expandable help.
The requested sprout is part of the feature name. The panel wraps controls
and scrolls within a bounded height so the history remains accessible.
Reviewed dark/light and 1000×640 Electron screenshots; the compact check
asserts no panel overflow and space for at least one history row.

M5 repository management: reran design-system for desktop Git repository
management and React controlled forms/async feedback. Kept 🌱 Twig's existing
identity and density instead of the suggested marketing layout. Native folder
selection, labeled inputs, explicit list removal, pending/Cancel states and live
Git output define the forms. Existing tokens only; dialogs capped at 760px.
Reviewed clone, repositories and remotes screenshots at 1000×640, including both
remote-manager themes; long paths wrap, forms scroll without horizontal overflow.

M5 profile, 2026-09-05: ran the skill design-system for a dense desktop developer
tool settings form, then React async-state and UX form-label/error-feedback
searches (`stacks/react.csv`, `ux-guidelines.csv`). Retained the logo palette,
local fonts and spacing below. Adopted explicit scope, visible labels, per-field
save/removal, inherited/effective values, loading skeletons, recoverable errors,
and keyboard-accessible controls. Marketing layout and new palette suggestions
do not override the existing desktop identity. Profile UI uses existing tokens.
M5 profile review: dark/light screenshots at 1000×640, no horizontal overflow,
scroll access to the final fields, keyboard focus within the dialog, Save/Remove
feedback and retry after stale edits checked in Electron. Dialog width is capped
at 700px to keep labels and field actions together.

M5 final review, 2026-09-06: ran the skill over every M5 screen (profile,
repositories, clone, remotes, SSH, branches and tags, stashes, bisect banner,
Undo/Redo toolbar) with `--domain ux`, `--domain web` and `--stack react`, then
read the dark and light screenshots produced by the Electron smokes.

Fixed from that pass: the branch search was the only control in the app that
cancelled its focus outline (`outline: none` with a border-colour change as the
sole replacement, which also made colour the only carrier of focus); the stash
screen printed "No stashes" during its first load instead of skeletons; the
stash heading glued its icon to the title because `.panel-heading > div` had no
flex rule where `.graph-heading > div` does; the row actions for rename,
upstream and delete were icon-only with an `aria-label` but no tooltip, so a
sighted mouse user had no name for them at all; ref badges in the graph were cut
mid-glyph for want of `text-overflow`. The command journal (up to 2000 rows) and
the ref rows now use `content-visibility: auto` with an intrinsic size, which
skips off-screen rendering without adding a virtualisation library.

Rejected, with reasons: 44px touch targets — this is a pointer-first desktop
tool and PROMPT.md fixes the row height at 28-32px; per-field inline errors —
§2.7 requires one readable line plus a link into the console, and the exact argv
lives there; `key={index}` for SSH config lines — a line's identity in that file
is its position; full list virtualisation for refs and the journal — the graph is
the only list that grows without bound, and content-visibility covers the rest;
deep linking of screen state — a single-window desktop app has no router.

Left open on purpose, not design defects: the graph does not mark commits
already tested by bisect, the toolbar Branch and Actions buttons are inert, and
the real repository sidebar has no STASHES/REMOTES sections (the demo panel
does). Full M5 UI review is complete; these are functional gaps listed in
CLAUDE.md.

M6 automations (increment 1), 2026-09-06: ran the skill with `--domain ux`
(`step progress execution status pass fail list keyboard`, `destructive
confirmation dangerous action trust permission`) and `--domain web` over the new
screens (Automations list, pipeline editor, execution overlay, run log, trust
prompt).

Adopted: a step indicator with a pass/fail count on the execution panel; a
spinner for each running step and a skeleton while the config loads; icon **and**
word for every status (`Check`/`X`/`Loader`/`Minus`), never colour alone — pass
reuses `--mark-green`, fail `--danger`, running/skipped `--muted`, so no new
tokens and `foundation.mjs` parity is untouched; the `RebaseDialog` reorder
pattern for the action list (drag plus Move up/down plus Alt+Arrow); visible
focus rings via the existing `:focus-visible` rule; explicit confirmation for
every trust and bypass action, with the exact command shown verbatim in the
editor, the execution panel, the console and the trust prompt; `prefers-reduced-
motion` disables the spinner animation.

Rejected, with reasons: deep linking / "URL reflects state" — a single-window
Electron app has no router, and screen state is in-memory like every other 🌱 Twig
screen; list virtualisation for pipelines and the run log — a repo has a handful
of pipelines and the log is capped at 100; mobile keyboard / `inputmode` / 44px
targets / 375px breakpoints — pointer-first desktop tool, min window 1000×640,
rows match the app's 30px density; design-system regeneration (palette, type,
style) — locked by this file, reuse only.

Read `.claude/skills/ui-ux-pro-max/SKILL.md`; ran `--design-system -p "Git Desk"`
with `desktop git client developer tool dense dark dashboard`, then searched
`style: dense data dashboard dark IDE`, `ux: keyboard focus contrast dense table`,
`chart: graph network curved edges labels`, and `--stack react: virtual list state events`.
Sources: `styles.csv`, `ux-guidelines.csv`, `charts.csv`, `stacks/react.csv` via the CLI.

Adopted: Data-Dense Dashboard, restrained surfaces, 13px text, 30px history rows,
visible focus, stable hover, local Fira Sans / Fira Code, semantic HTML, tab state
preservation. Rejected the initial marketing-page recommendation (hero, sales CTA,
48px gaps): a desktop Git workspace requires the anatomy in PROMPT.md.
The user-supplied 🌱 Twig logo defines the palette: forest green, bright lime,
mint and ivory. Use the original logo locally; no external fonts or images. Lucide SVG icons share 16px size and 1.7px stroke.

Spacing: 4/8/12/16/24/32 px. Radii: 4/6/10 px. Shadows only on dialogs.
Graph lanes use lime, mint and cream (darker green/olive in light mode); node labels and parent links duplicate
color information. M0 has a fixed illustration, not the M2 DAG layout algorithm.
Complex conflict and diff layouts must go through the skill again in M3/M4.

Desktop minimum: 1000×640; reviewed at 1000×640 and 1440×920. Compact sidebar
and hidden optional author column make space at small widths. Mobile adaptations
from the skill do not override this desktop brief. Keyboard targets may be 30px;
coarse pointers get 44px targets. System theme by default; explicit theme persists.

```css
:root {
  --font-ui: 'Fira Sans', system-ui, sans-serif;
  --font-mono: 'Fira Code', ui-monospace, monospace;
  --text-xs: 11px;
  --text-sm: 12px;
  --text-md: 13px;
  --text-lg: 14px;
  --text-title: 20px;
  --text-hero: 28px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --row-height: 30px;
  --tabs-height: 46px;
  --toolbar-height: 78px;
  --sidebar-width: 212px;
  --detail-width: 306px;
  --splitter-width: 5px;
  --motion: 160ms;
  --z-menu: 30;
  --icon-size: 16px;
  --brand-icon-size: 36px;
  --welcome-logo-size: 96px;
}
:root, :root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #071e18;
  --surface: #0d2a20;
  --surface-raised: #143628;
  --surface-hover: #1e4532;
  --border: #355747;
  --text: #f8fae9;
  --muted: #b6cbb7;
  --accent: #b7f56d;
  --accent-bg: #254726;
  --accent-text: #071e18;
  --lane-mint: #79dfbd;
  --lane-cream: #eff6bd;
  --lane-leaf: #abe39a;
  --age-fresh: #7ef0a6;
  --age-young: #bff081;
  --age-mature: #ecd98a;
  --age-old: #e3b78b;
  --age-root: #dca58a;
  --mark-red: #ff8a80;
  --mark-amber: #ffce6b;
  --mark-green: #7ee787;
  --mark-blue: #7fbfff;
  --mark-violet: #d0a9ff;
  --mark-slate: #b0becb;
  --danger: #ffc2b2;
  --shadow: 0 16px 48px #00000066;
  --overlay: #00000080;
}
:root[data-theme='light'] {
  color-scheme: light;
  --bg: #f8faee;
  --surface: #edf2e3;
  --surface-raised: #fffff6;
  --surface-hover: #dfe8d4;
  --border: #becdb6;
  --text: #102d23;
  --muted: #46604b;
  --accent: #30621e;
  --accent-bg: #dfedc9;
  --accent-text: #fffff6;
  --lane-mint: #16604a;
  --lane-cream: #626018;
  --lane-leaf: #3e602b;
  --age-fresh: #15683f;
  --age-young: #40631a;
  --age-mature: #6a5410;
  --age-old: #7c4a1c;
  --age-root: #6f3626;
  --mark-red: #c62f2f;
  --mark-amber: #8a5a00;
  --mark-green: #2e7d32;
  --mark-blue: #1f5fbf;
  --mark-violet: #7b3fbf;
  --mark-slate: #556370;
  --danger: #973b2e;
  --shadow: 0 16px 48px #102d2326;
  --overlay: #102d2366;
}
```

Blame, Blame History and Reverse Blame, 2026-09-07 (outside milestones): ran the
skill `--design-system` for a dense desktop Git blame code view plus the web and
react domains (`virtualize keyboard focus list navigation history back forward`,
`virtual list state events request race stale`). Kept 🌱 Twig's identity, tokens,
local Fira pair and 30px density; rejected the generic "Enterprise Gateway /
Vibrant block" marketing recommendation and the IBM Plex / JetBrains Mono pair —
the app already ships Fira Sans / Fira Code and every prior feature reuses them.
Adopted: virtualised line list (same windowing as `CommitGraph`, no new library);
a commit chip printed once per run of same-commit lines with a coloured spine
continuing down the run, so adjacent lines read as one block; the reverse-blame
row carries the word "Present at end" / "Last present in …" next to a shape, not
colour alone; `:focus-visible` rings from the existing rule; `onKeyDown` beside
every `onClick`; async reads guarded by a request counter so a stale file, mode
or repository never repaints the current screen; `prefers-reduced-motion` already
covered globally. New tokens: none — the chip reuses `--surface-raised` /
`--border` / `--muted`, the "before/after" markers reuse `--accent` and
`--danger`. Dialog/panel widths reuse `PANEL_MAX`. Review: dark/light Electron
screenshots at 1000×640 in `artifacts/blame-*`; no root overflow, focus visible,
list and detail scroll independently.

## M0 review

File history review, 2026-09-06: ran the design-system for a dense desktop Git
history and React async-effect guidelines. Kept the existing palette, typography
and resizable right panel. Selecting a history row highlights it with both an
inset marker and aria-pressed and displays its file diff alongside the list;
Go to commit is a separate labeled action. Reviewed dark/light Electron shots
at 1000×640: independent scrolling, visible selection, no window overflow.

Re-ran UX focus/keyboard/contrast and React effect-cleanup searches. Reviewed
actual Electron screenshots in both themes at 1440×920 and 1000×640; focus stays
visible, dialogs restore focus, panels scroll independently, no root overflow.
All text palette colors pass 4.5:1 against every surface, including selection
and hover. Dark/light and compact screenshots are in ignored `artifacts/`.
Compact graph keeps the same SVG width to avoid scaling gaps between rows.
Future graph virtualization, diff and conflict editor still require their own
milestone review; this review covers only the M0 shell.

## 🌱 Twig identity update

User-selected name: **🌱 Twig**. Source: `design/twig-logo.png`, the unmodified
1254×1254 PNG supplied by the user. Platform icons in `build/` and the small
renderer logo are resized/encoded copies of this same image, never redrawn.

Ran the skill with `--design-system -p 🌱 Twig` and `desktop git client dense forest
green lime cream`, followed by UX contrast/focus review. Kept the established
dense desktop layout and font pair; discarded the marketing/oversized-type
recommendations. The user's palette and name take precedence over the generic
skill recommendations, including its general advice against emoji icons: the
seedling is part of the requested product name, not an action icon.

Forest surfaces and ivory text mirror the logo. Lime marks selection and focus;
mint and cream distinguish graph lanes. Light mode uses ivory surfaces with
forest/olive text for readable contrast. Warm error color remains semantic.
All foregrounds are checked against all surfaces at 4.5:1 by `npm test`.

🌱 Twig review completed on macOS: production build and Electron smoke passed;
checked actual dark/light screenshots and the compact layout. Screenshots now
finish CSS transitions before capture, so foregrounds are assessed against the
matching theme surfaces. SVG lanes retain their labels and remote-ref dash style.

## Demo sandbox + reinit (2026-09-07)

`workspace-demo` is now a real seeded Git repository, so it reuses the already
reviewed `HistoryWorkspace` screen — no new screen. Ran the skill for a
destructive-confirmation review of the only new surface: a **Reset demo
workspace** control in the Settings dialog and its confirm step.

Accepted: keep the reinit affordance inside the Settings dialog as a labelled
`.setting-row` (Appearance / Commit colors / Demo workspace), not a toolbar
button — it is rare and destructive. The confirm reuses the vetted
`.confirm-dialog` / `.confirm-consequence` / `.dialog-actions` / `.danger`
pattern from `features/ops/dialogs.jsx`: `AlertTriangle` icon plus text (colour
is never the only signal), a plain-language consequence list, and the
destructive button last in tab order. Native `<dialog>` keeps the focus trap,
Esc handling and focus return; `closeReason` blocks Esc/close while the reset
runs; both action buttons disable during the operation; success is a brief
`sync-note`. No `$ git …` line is shown because a reset is `rm -rf` plus a
scripted re-seed, not one command — the consequence list is the honest form.

Rejected: the skill's generic "no emoji icons" (the seedling is the product
name, per the identity note above) and any marketing-scale typography.

## Product website review (2026-09-08)

Ran ui-ux-pro-max design-system for a professional Git developer tool and
UX animation/accessibility search. Kept the existing forest/lime and cream
palettes and local Fira Sans. The website build scopes the existing light
palette to section containers; colour values are no longer duplicated in
site/style.css. No renderer token changes.

Accepted: product demonstration in the hero, a grid of four concrete features,
44 px tab targets, visible focus, keyboard arrows/Home/End, finite 350–650 ms
transform/opacity animations and reduced-motion support. Static HTML remains
readable if scripts fail; all demo scenarios are visible without JavaScript.
Rejected: horizontal scroll journeys, scroll hijacking, unrelated new fonts,
continuous decorative motion, stock social proof and unsupported speed claims.

Spacing: 92 px section rhythm (62 px on mobile), 20 px feature gaps, 25–32 px
card padding. Existing 6–12 px radii, app shadows and palette tokens. The
original logo stays in navigation/footer; the hero demonstrates the product.
