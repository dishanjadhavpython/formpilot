# FormPilot — One UI 8.5 UI Master Prompt

> All UI work follows this document. Every visual value lives in
> `styles/one-ui.css` as a custom property; nothing else hard-codes a colour,
> radius, spacing, type step, shadow or duration.

---

## 1. Design language (what "One UI 8.5" means here)

- **Liquid-glass floating surfaces.** Bars, sheets and the primary action bar are translucent
  panels with backdrop blur, a hairline light border, and a soft shadow — they float above content.
- **Everything rounded.** Pill-shaped buttons and bars, big-radius cards, rounded grouped lists.
- **Bottom-anchored reachability.** The primary action (and search, when present) lives in a
  **floating pill bar near the bottom**, not a toolbar at the top.
- **Big, calm titles.** Large, bold, left-aligned screen titles; content "breathes" with generous
  spacing.
- **Tactile "pop" feedback.** Buttons scale down slightly and deepen on press.
- **Smooth motion + edge fade.** Spring-like easing; content softly fades at the top/bottom of
  scroll areas.
- **Minimal, unified, one confident accent** (a One UI blue) over a neutral palette.
- Glass/blur is used **only on floating layers** (bottom bar, sheets), never on every card.

Font: Samsung Sans is proprietary, so use the closest free stack:
`font-family: "Inter","SamsungOne","system-ui",-apple-system,"Segoe UI",Roboto,sans-serif;`
(If a Samsung-Sans-like font file is added to `/fonts` later, swap it into the stack.)

---

## 2. Design tokens

Defined once, in `styles/one-ui.css`. Light values on `:root`, dark values under
`@media (prefers-color-scheme: dark)`.

Groups: colour (`--bg`, `--surface`, `--surface-2`, `--glass-bg`, `--glass-border`, `--text`,
`--text-2`, `--text-3`, `--accent`, `--accent-press`, `--accent-soft`, `--success`, `--danger`,
`--warn`, `--divider`, shadows) · radius (`--r-pill` … `--r-sm`) · spacing on a 4pt base
(`--s1` … `--s10`) · type (`--t-display` … `--t-caption`) · motion (`--ease`, `--dur`).

To re-theme, edit only that block.

---

## 3. Layout shell

- **Popup:** width **380px**, min-height ~520px, `background:var(--bg)`, horizontal padding
  `var(--s5)`. Reserve space at the bottom for the floating action bar.
- **Options page:** center **one column, max-width 460px**, `margin:0 auto`, `min-height:100vh`,
  `background:var(--bg)`, padding `var(--s5)` — it should feel like a Galaxy phone screen on desktop.
- **Screen title:** `.app-title` uses `--t-display`, left-aligned, optional secondary line in
  `--text-2`.
- Content = a vertical stack of rounded **cards** / **grouped lists** with `var(--s4)` gaps.
- **Scroll edge fade:** `.scroll-fade` applies a ~24px `mask-image` at the top/bottom of a
  scrolling region.

---

## 4. Components

`.bottom-bar` (signature element) · `.btn` + `.btn--primary` / `--tonal` / `--neutral` / `--danger`
/ `--sm` · `.icon-btn` · `.card` · `.list` / `.list__row` · `.field` · `.switch` · `.chip` ·
`.sheet` · `.progress`.

The bottom bar is glass: `var(--glass-bg)` with `backdrop-filter: blur(20px) saturate(180%)`, a
`var(--glass-border)` hairline, `--r-pill` radius and `var(--shadow)`.

---

## 5. Motion, states, accessibility

- Standard transition `var(--dur) var(--ease)`; press feedback `scale(0.97)`; sheets spring in ~280ms.
- `:focus-visible` → `box-shadow: 0 0 0 4px var(--accent-soft); border-color: var(--accent);`
- Contrast AA; never put secondary text lighter than `--text-2` on light backgrounds.
- `@media (prefers-reduced-motion: reduce)` disables animation and transition everywhere.
- Icons: rounded line set, 22–24px, ~1.8 stroke, rounded caps.

---

## 6. Do / Don't

**Do:** anchor the primary action to the bottom floating pill • use large radii + generous spacing
• use glass/blur only on floating layers • give buttons a scale-press "pop" • ship light + dark.

**Don't:** sharp corners, dense tables, tiny buttons, or the flat default Material gray look •
transparency behind body text • hard-coded values outside the token file • changing any IDs or JS.

---

## 7. As built — decisions worth knowing

Notes from applying this to the existing extension. Read before changing the CSS.

**Runtime classes are load-bearing.** `options.js` and `content.js` build DOM at runtime with
fixed class names — `status` (+ `ok`/`err`/`warn`), `empty`, `doc`, `doc-grid`, `doc-actions`,
`thumb`, `meta`, `custom-row`, `maps`, `ocr-row`, `saved-badge`, `conf` (+ `high`/`low`/`bad`),
`sub`, `note`, `badge`, `hidden`, and the button modifiers `danger` / `tiny` / `secondary`.
Renaming any of them breaks behaviour, so `one-ui.css` styles them directly (section 13 onward)
rather than replacing them. `hidden` in particular is how `showView()` switches screens.

**The base button is the element selector.** `button { … }` carries the pill style so buttons
created in JavaScript inherit it without needing a class.

**The switch is a real checkbox.** `input[type=checkbox]` is restyled into the One UI track/knob
with `appearance: none`, so `highlight.checked` still works untouched.

**One bottom bar per view, not one per page.** The options page shows several sections at once, and
each state has a different primary action (Create vault / Unlock / Save vault). Each `.bottom-bar`
therefore lives *inside* its view section and is `position: sticky`, so exactly one is visible at a
time and no JavaScript is needed to swap it. Status text stays in the content flow — never inside
the glass, per "no transparency behind body text".

**Two grids were stacked after visual testing.** `.add-doc` and `.result` were side-by-side and
broke at 460px: Chrome truncated the file input to `N...n`, and stats wrapped every value onto two
lines. Both are single-column now. `.doc-actions` is stacked for the same reason.

**The content script cannot use this file.** `content.js` renders into a Shadow DOM on third-party
pages, where these tokens do not exist. It carries its own `:host` token block mirroring the values
here; keep the two in sync by hand.

**Icons follow the accent.** `icons/*.png` are generated by a script (see git history for
`phase 0` and the design commit) and were re-rendered in `--accent` blue — a green mark against a
blue accent broke "one confident accent".

**Unused by design.** `.list` / `.list__row`, `.chip`, `.sheet` and `.icon-btn` are built per this
spec but not yet used; the app currently has no bottom sheet or chip surface, and uses native
`confirm()` / `prompt()` for dialogs.
