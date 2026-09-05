# 🌱Twig — design tokens

M0, 2026-09-05. Source of truth: CSS below is copied exactly to
`renderer/src/ui/tokens.css`; `npm test` checks parity and text contrast.

## Skill decisions

Read `.claude/skills/ui-ux-pro-max/SKILL.md`; ran `--design-system -p "Git Desk"`
with `desktop git client developer tool dense dark dashboard`, then searched
`style: dense data dashboard dark IDE`, `ux: keyboard focus contrast dense table`,
`chart: graph network curved edges labels`, and `--stack react: virtual list state events`.
Sources: `styles.csv`, `ux-guidelines.csv`, `charts.csv`, `stacks/react.csv` via the CLI.

Adopted: Data-Dense Dashboard, restrained surfaces, 13px text, 30px history rows,
visible focus, stable hover, local Fira Sans / Fira Code, semantic HTML, tab state
preservation. Rejected the initial marketing-page recommendation (hero, sales CTA,
48px gaps): a desktop Git workspace requires the anatomy in PROMPT.md.
The user-supplied Twig logo defines the palette: forest green, bright lime,
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
  --motion: 160ms;
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
  --danger: #973b2e;
  --shadow: 0 16px 48px #102d2326;
  --overlay: #102d2366;
}
```

## M0 review

Re-ran UX focus/keyboard/contrast and React effect-cleanup searches. Reviewed
actual Electron screenshots in both themes at 1440×920 and 1000×640; focus stays
visible, dialogs restore focus, panels scroll independently, no root overflow.
All text palette colors pass 4.5:1 against every surface, including selection
and hover. Dark/light and compact screenshots are in ignored `artifacts/`.
Compact graph keeps the same SVG width to avoid scaling gaps between rows.
Future graph virtualization, diff and conflict editor still require their own
milestone review; this review covers only the M0 shell.

## Twig identity update

User-selected name: **🌱Twig**. Source: `design/twig-logo.png`, the unmodified
1254×1254 PNG supplied by the user. Platform icons in `build/` and the small
renderer logo are resized/encoded copies of this same image, never redrawn.

Ran the skill with `--design-system -p Twig` and `desktop git client dense forest
green lime cream`, followed by UX contrast/focus review. Kept the established
dense desktop layout and font pair; discarded the marketing/oversized-type
recommendations. The user's palette and name take precedence over the generic
skill recommendations, including its general advice against emoji icons: the
seedling is part of the requested product name, not an action icon.

Forest surfaces and ivory text mirror the logo. Lime marks selection and focus;
mint and cream distinguish graph lanes. Light mode uses ivory surfaces with
forest/olive text for readable contrast. Warm error color remains semantic.
All foregrounds are checked against all surfaces at 4.5:1 by `npm test`.

Twig review completed on macOS: production build and Electron smoke passed;
checked actual dark/light screenshots and the compact layout. Screenshots now
finish CSS transitions before capture, so foregrounds are assessed against the
matching theme surfaces. SVG lanes retain their labels and remote-ref dash style.
