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
`.sheet` · `.progress` · `.tiles` / `.tile` · `.sec-icon`.

The bottom bar is glass: `var(--glass-bg)` with `backdrop-filter: blur(20px) saturate(180%)`, a
`var(--glass-border)` hairline, `--r-pill` radius and `var(--shadow)`.

**Glass on cards.** `.card` / `section` are translucent (`--card-bg`) over an ambient background:
`body::before` paints three fixed radial accent glows. That background is what the blur refracts —
without it, translucency just looks grey. Card opacity is deliberately high (0.84 light / 0.78
dark) because body text sits on it; do not lower it.

**Colour.** Body text and controls stay on the single accent. The `--hue-*` tokens (blue, violet,
teal, amber, rose, green) are for **icon chips only** — `.tile__icon` and `.sec-icon` — so the
interface still reads as one system rather than a rainbow.

**Feature tiles** (`.tiles` / `.tile`) are the popup's map of the extension: icon chip, name, and a
one-line description. Each carries `data-open="<sectionId>"`; `popup.js` opens
`options.html#<sectionId>` and `options.js` scrolls there via `revealHashTarget()`.

**Motion.** Cards and tiles enter with a staggered `rise` (fade + 10px translate). Tiles lift on
hover and scale on press. Progress bars carry a moving `sheen` gradient so a slow OCR pass looks
alive. The unlocked badge plays a single `pop`. All of it is disabled by the global
`prefers-reduced-motion` rule.

---

## 5. Motion, states, accessibility

- Standard transition `var(--dur) var(--ease)`; press feedback `scale(0.97)`; sheets spring in ~280ms.
- `@media (prefers-reduced-motion: reduce)` disables animation and transition everywhere.
- Icons: rounded line set, 22–24px, ~1.8 stroke, rounded caps.

### Focus

```css
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px;
                 box-shadow: 0 0 0 4px var(--accent-soft); }
```

**Never `outline: none` with only the soft glow.** That is what this was, and
`--accent-soft` is a 12%-alpha blue measuring about 1.2:1 against the page where
WCAG asks 3:1 — so keyboard focus was effectively invisible on every button in
the extension. `border-color` in the same rule did nothing, because
`button, .btn` sets `border: none`.

The `outline-offset` is load-bearing: an accent ring drawn flush against an
accent-filled button cannot be seen. `outline` rather than `box-shadow` because
it still renders outside an `overflow: hidden` ancestor. A `forced-colors: active`
block re-states the ring in the system `Highlight` colour, since high-contrast
mode discards every custom property above.

### Contrast

Every token that carries text clears **4.5:1** against both `--bg` and
`--surface`, in **both** themes. This is measured, not judged:
`test/contrast.test.mjs` computes it on every run and fails the build otherwise,
so a "slightly nicer" lighter grey cannot drift back in.

Two consequences worth knowing before you touch the palette:

- **`--on-tonal` exists because `--accent` is not enough.** Anything sitting on
  an `--accent-soft` tint — tonal buttons, inline `code`, the unlocked badge —
  needs the stronger blue: the tint darkens the ground just enough that plain
  `--accent` lands at 4.29:1.
- **Restate colours in the dark block even when they "look fine".** `--success`
  was inherited from light for a long time; a green picked to clear 4.5:1 on
  white measures about 2.5:1 on near-black, so every "Saved" confirmation was
  unreadable in dark mode. The test now catches exactly this.

### The three places a token cannot reach

`content.js` renders into somebody else's page, where our custom properties do
not exist, so it hard-codes the accent twice — the outline drawn on a filled
field, and the `:host` block of its closed shadow root. `background.js` hard-codes
it once more, because `chrome.action.setBadgeBackgroundColor` takes a colour
string rather than CSS.

These are legitimate exceptions to "nothing else hard-codes a colour", and the
contrast test asserts all three still equal `--accent` — otherwise a palette
change leaves the in-page chip and the toolbar badge on the old blue while every
other surface moves.

### Reachability

Anything positioned by dragging needs a keyboard path to the same result. The
crop stage is focusable and takes arrow keys to move, `+`/`-` to zoom and `Home`
to reset — a crop you can only place with a pointer is a feature that does not
exist for part of the audience.

---

## 6. Do / Don't

**Do:** anchor the primary action to the bottom floating pill • use large radii + generous spacing
• use glass/blur only on floating layers • give buttons a scale-press "pop" • ship light + dark.

**Don't:** sharp corners, dense tables, tiny buttons, or the flat default Material gray look •
transparency behind body text • hard-coded values outside the token file • changing any IDs or JS.

---

## 6b. Liquid Glass material layer

`styles/liquid-glass.css`, loaded **after** `one-ui.css`. One UI owns layout,
type and colour; this file owns one thing: the material used by floating layers.

| Surface | Classes |
|---|---|
| Bottom action bar (the hero) | `.lg .lg--refract` |
| Sheets / dialogs | `.sheet` (material applied directly) or `.lg .lg--thick` |
| Popovers | `.lg .lg--popover` |
| **Content cards, sections, inputs** | **none — solid** |

Cards are deliberately solid. Body copy over a live backdrop is the fastest way
to fail WCAG AA, and these cards carry every label and value in the app. The
ambient `body::before` glows exist so the *floating* layers have something worth
refracting.

**Refraction is two independent things.** `.lg--refract::before` runs the SVG
filter on the sheen only — that works wherever `filter: url()` does, and can
never smear text because the text is in a different layer. True backdrop
refraction sits behind `@supports (backdrop-filter: url(#lg-refract))` as a
progressive enhancement.

**`.lg` must not set `position`.** This file loads after one-ui.css, so a
`position: relative` on `.lg` beats `.bottom-bar { position: sticky }` at equal
specificity and silently un-floats the hero surface — it drops to its natural
place partway down the document. Every current host is already positioned; a
static host adds `.lg--block`.

**View transitions.** `runViewTransition()` in options.js. It skips the first
render (nothing to cross-fade from, and starting mid-load is when the UA aborts
on timeout) and honours `prefers-reduced-motion`. Its `ready` and `finished`
promises **reject** on a skipped transition — routine, but unhandled they trip
the fatal-error banner, so both are explicitly caught.

**Accessibility, all three honoured:** `prefers-reduced-transparency` goes fully
solid, `prefers-contrast: more` thickens tint and border, `prefers-reduced-motion`
disables animation including view transitions. A root `.lg-tinted` / `.lg-clear`
toggle is exposed in Settings and mirrored by the popup.

**`--on-accent`.** The dark-mode accent is a *light* blue, so white on it
measured 3.03:1 — under AA for 14px text. Filled buttons now use dark ink in
dark mode (6.49:1).

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

**Inputs need a visible edge on glass.** Their border was `transparent` while cards were opaque.
Once cards became translucent the fields disappeared into them, so the border is now `--divider`.

**Email rows stack.** `.custom-row--email` puts the label and Remove on one line
and the address full-width below. Side by side, a real address always clipped —
there is not enough room for a label, an address and a button in a 460px column.

**The popup has a hard 600px ceiling.** Chrome will not render a taller popup. Header + six tiles +
action bar + footer only just fit, which is why `.tile` padding and the popup's own spacing are
tighter than the rest of the system. Adding a seventh tile means removing something else.

**Verify UI changes by rendering, not by reading.** A headless Chrome pass against stubbed
`chrome.*` APIs is how the `N...n`, "Passpc" and stats-wrapping breaks were caught — and how the
`views.unlocked.addEventListener` crash should have been caught. Always check the console, not just
the screenshot: that crash left the page blank while the screenshots still looked fine, because the
harness was force-showing views that `boot()` had never rendered.
