# Git Desk — design tokens

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
Palette is our graphite/amber identity, not a product reference palette. No remote
fonts, brand marks or images. Lucide SVG icons share 16px size and 1.7px stroke.

Spacing: 4/8/12/16/24/32 px. Radii: 4/6/10 px. Shadows only on dialogs.
Graph lanes use amber, blue, violet, teal; node labels and parent links duplicate
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
}
:root, :root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #17191d;
  --surface: #1e2126;
  --surface-raised: #25292f;
  --surface-hover: #30353d;
  --border: #383e47;
  --text: #e7e9ee;
  --muted: #a4adbb;
  --accent: #edbd75;
  --accent-bg: #3c3326;
  --accent-text: #17191d;
  --blue: #85b9f4;
  --violet: #c1a1ee;
  --teal: #86c9bc;
  --danger: #f19b9b;
  --shadow: 0 16px 48px #00000066;
  --overlay: #00000080;
}
:root[data-theme='light'] {
  color-scheme: light;
  --bg: #f8f7f4;
  --surface: #eeede9;
  --surface-raised: #ffffff;
  --surface-hover: #e1dfd9;
  --border: #cbc9c2;
  --text: #24272d;
  --muted: #56606e;
  --accent: #795018;
  --accent-bg: #f0e1c8;
  --accent-text: #ffffff;
  --blue: #28649f;
  --violet: #704499;
  --teal: #276c60;
  --danger: #a73c3c;
  --shadow: 0 16px 48px #24272d26;
  --overlay: #24272d66;
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
