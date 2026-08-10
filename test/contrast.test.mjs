// FormPilot - can you actually read it?
//
//   node test/contrast.test.mjs
//
// Colour contrast is the one design property that is objectively measurable and
// almost never measured. It is also the one that decays silently: every token
// here was chosen by eye at some point and looked fine on the display it was
// chosen on, and several of them were not fine at all. --text-3 sat at 2.4:1
// against the page, where WCAG asks 4.5:1 for text; the focus ring was a
// 12%-alpha blue at 1.2:1, where it asks 3:1 for a non-text indicator.
//
// So this measures them. Both themes, against both the page and a card, on
// every run. A "slightly nicer" lighter grey cannot creep back in without
// failing the build.
//
// Thresholds are WCAG 2.1 AA: 4.5:1 for normal text, 3:1 for large text and for
// non-text indicators like a focus ring.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(ROOT, 'styles/one-ui.css'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// --- Colour maths (WCAG 2.1 relative luminance) ------------------------------

const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
};

function parse(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255, 1];
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value.trim());
  if (rgba) return [+rgba[1], +rgba[2], +rgba[3], rgba[4] === undefined ? 1 : +rgba[4]];
  return null;
}

/** Composite a possibly-translucent colour over an opaque one. */
const over = (fg, bg) => fg[3] >= 1 ? fg : fg.map((c, i) => (i === 3 ? 1 : c * fg[3] + bg[i] * (1 - fg[3])));

const luminance = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

function contrast(fg, bg) {
  const a = luminance(over(fg, bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// --- Pull the two token sets out of the stylesheet ---------------------------

function tokensIn(block) {
  const map = new Map();

  // Comments first. The tokens are documented in prose that names other tokens
  // ("Ink for anything sitting ON --accent-soft: ..."), and a declaration regex
  // run over that happily matches the mention, swallows everything up to the
  // next real semicolon, and silently loses the declaration that followed it.
  const declarations = block.replace(/\/\*[\s\S]*?\*\//g, '');

  for (const m of declarations.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const colour = parse(m[2]);
    if (colour) map.set(m[1], colour);
  }
  return map;
}

// The first :root is light. The dark set is inside the prefers-color-scheme
// block, and inherits anything it does not restate - which is exactly how
// --success was silently wrong in dark mode until this test existed.
const lightBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
const darkBlock = /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n  \}/.exec(css)?.[1] ?? '';

const light = tokensIn(lightBlock);
const darkOverrides = tokensIn(darkBlock);
const dark = new Map([...light, ...darkOverrides]);

console.log('\n0. The token sets were found');
ok('light tokens parsed', light.size > 20, `${light.size} colours`);
ok('dark tokens parsed', darkOverrides.size > 10, `${darkOverrides.size} overrides`);
ok('both define --bg and --surface',
  light.has('--bg') && light.has('--surface') && dark.has('--bg') && dark.has('--surface'));

// --- The checks --------------------------------------------------------------

const TEXT_MIN = 4.5;      // WCAG AA, normal text
const NON_TEXT_MIN = 3;    // WCAG AA, focus rings and other indicators

// Every colour that ever carries words, against both surfaces it can sit on.
const TEXT_TOKENS = ['--text', '--text-2', '--text-3', '--accent', '--success', '--danger', '--warn'];

for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
  console.log(`\n${theme === 'light' ? 1 : 2}. ${theme} theme — text colours`);

  for (const name of TEXT_TOKENS) {
    const colour = tokens.get(name);
    if (!colour) { ok(`${name} is defined`, false, 'missing'); continue; }

    // The worst of the two backgrounds is the one that matters: a card and the
    // page behind it are different colours, and text sits on both.
    const onBg = contrast(colour, tokens.get('--bg'));
    const onSurface = contrast(colour, tokens.get('--surface'));
    const worst = Math.min(onBg, onSurface);

    ok(`${name.padEnd(10)} reads as text`, worst >= TEXT_MIN,
      `${worst.toFixed(2)}:1 (page ${onBg.toFixed(2)}, card ${onSurface.toFixed(2)})`);
  }

  // A filled accent button: the label has to survive on it.
  const onAccent = contrast(tokens.get('--on-accent'), tokens.get('--accent'));
  ok('--on-accent on a filled button', onAccent >= TEXT_MIN, `${onAccent.toFixed(2)}:1`);

  const onPress = contrast(tokens.get('--on-accent'), tokens.get('--accent-press'));
  ok('--on-accent while pressed', onPress >= TEXT_MIN, `${onPress.toFixed(2)}:1`);

  // Tonal buttons, inline code and the unlocked badge all put text on an
  // accent-TINTED surface, which is darker than the surface underneath. Plain
  // --accent measures 4.29:1 there, so those use --on-tonal instead.
  const tonalBg = over(tokens.get('--accent-soft'), tokens.get('--surface'));
  const tonal = contrast(tokens.get('--on-tonal'), tonalBg);
  ok('--on-tonal on a tonal surface', tonal >= TEXT_MIN, `${tonal.toFixed(2)}:1`);

  // The reason --on-tonal exists at all. If a future accent happens to clear
  // 4.5:1 on the tint, the extra token is harmless; if this ever passes it is
  // worth knowing the workaround could be retired.
  const plainAccentOnTint = contrast(tokens.get('--accent'), tonalBg);
  console.log(`        (plain --accent on that tint would be ${plainAccentOnTint.toFixed(2)}:1)`);

  // The focus ring is drawn in --accent, offset clear of the control, so it is
  // judged against the page it sits on.
  const ring = contrast(tokens.get('--accent'), tokens.get('--bg'));
  ok('the focus ring is visible', ring >= NON_TEXT_MIN, `${ring.toFixed(2)}:1`);
}

// --- The hierarchy has to survive the fix ------------------------------------

console.log('\n3. The three text steps stay distinguishable');

// Making everything 4.5:1 is easy; making it 4.5:1 AND still a hierarchy is the
// point. If --text-2 and --text-3 converge, the design has lost a level.
for (const [theme, tokens] of [['light', light], ['dark', dark]]) {
  const step = contrast(tokens.get('--text-2'), tokens.get('--text-3'));
  ok(`${theme}: --text-2 and --text-3 are still different`, step >= 1.2,
    `${step.toFixed(2)}:1 between them`);

  const primary = contrast(tokens.get('--text'), tokens.get('--bg'));
  const tertiary = contrast(tokens.get('--text-3'), tokens.get('--bg'));
  ok(`${theme}: the scale runs the right way`, primary > tertiary,
    `${primary.toFixed(2)} > ${tertiary.toFixed(2)}`);
}

// --- The rule that was actually broken ---------------------------------------

console.log('\n4. The focus rule itself');

{
  // The BASE rule, anchored at line start. Unanchored, this matched
  // `.skip-link:focus-visible` the moment one was added and quietly started
  // asserting things about the wrong selector.
  const rule = /^:focus-visible\s*\{([^}]*)\}/m.exec(css)?.[1] ?? '';
  ok('a focus rule exists', rule.length > 0);
  ok('it does not suppress the outline', !/outline:\s*none/.test(rule),
    'outline:none with only a soft glow left keyboard focus invisible');
  ok('it draws a real outline', /outline:\s*\d+px/.test(rule), rule.trim().split('\n')[0]);
  ok('the outline is offset clear of the control', /outline-offset/.test(rule),
    'without it, an accent ring on an accent-filled button is invisible');
  ok('forced-colours mode keeps a focus ring',
    /@media \(forced-colors: active\)[\s\S]{0,200}outline/.test(css),
    'high-contrast mode replaces every custom colour');
}

// ============================================================================
console.log('\n5. The three hard-coded copies of the accent still match');
// ============================================================================
//
// Three places genuinely cannot read a custom property, and each holds a literal
// copy of --accent:
//
//   content.js  twice — it renders into somebody else's page, where our tokens
//               do not exist: once for the outline drawn on a filled field, and
//               once inside the closed shadow root's own :host block.
//   background.js — chrome.action.setBadgeBackgroundColor takes a colour string,
//               not CSS.
//
// Nothing keeps them in step with the stylesheet, so a palette change leaves the
// in-page UI and the toolbar badge on the old blue while everything else moves.

{
  const accent = lightBlock.match(/--accent\s*:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toUpperCase();
  ok('--accent was read from the stylesheet', Boolean(accent), String(accent));

  const sources = {
    'content.js': fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'),
    'background.js': fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
  };

  const outline = sources['content.js'].match(/outline',\s*'2px solid (#[0-9a-fA-F]{6})'/)?.[1]?.toUpperCase();
  ok('content.js fill outline matches --accent', outline === accent, `${outline} vs ${accent}`);

  const host = sources['content.js'].match(/--accent:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toUpperCase();
  ok('content.js shadow-root :host matches --accent', host === accent, `${host} vs ${accent}`);

  const badge = sources['background.js'].match(/setBadgeBackgroundColor\([^)]*color:\s*'(#[0-9a-fA-F]{6})'/)?.[1]?.toUpperCase();
  ok('the toolbar badge matches --accent', badge === accent, `${badge} vs ${accent}`);
}

// ============================================================================
console.log('\n6. The brand mesh is decoration, and nothing readable trusts it');
// ============================================================================
//
// The reference this was drawn from puts white body copy straight onto a lilac
// gradient stop. Measured, that is 2.19:1 — a beautiful mockup that would fail
// an audit on its own screenshot. The mesh is kept exactly as bright, and every
// readable thing is moved onto a layer dark enough to carry white over ANY stop,
// so the design does not depend on where a radial happens to land at some
// viewport size nobody tested.

{
  const stops = ['--brand-1', '--brand-2', '--brand-3', '--brand-4']
    .map((name) => [name, light.get(name)]);

  ok('all four mesh stops are defined', stops.every(([, c]) => c), stops.map(([n]) => n).join(' '));

  // The honest baseline: at least one stop must be too light for white text.
  // If that ever stops being true the mesh has been dulled into a flat ground,
  // and the scrim and panel below are solving a problem that no longer exists.
  const barest = Math.min(...stops.map(([, c]) => contrast(light.get('--brand-ink'), c)));
  console.log(`        (white directly on the lightest stop: ${barest.toFixed(2)}:1 — which is why nothing sits there)`);

  const panel = light.get('--brand-panel');
  ok('--brand-panel is translucent and dark', panel && panel[3] < 1 && luminance(panel) < 0.2,
    panel ? `alpha ${panel[3]}` : 'missing');

  for (const [name, stop] of stops) {
    // Panel text: the feature rows.
    const onPanel = contrast(light.get('--brand-ink'), over(panel, stop));
    ok(`white on the panel over ${name}`, onPanel >= TEXT_MIN, `${onPanel.toFixed(2)}:1`);

    // Secondary ink: the descriptions under each feature title.
    const secondary = contrast(light.get('--brand-ink-2'), over(panel, stop));
    ok(`secondary ink on the panel over ${name}`, secondary >= TEXT_MIN, `${secondary.toFixed(2)}:1`);
  }

  // The headline sits under the scrim rather than on the panel. Take the scrim's
  // WEAKEST band — the point furthest down the card, where it has almost faded —
  // because that is the worst case for anything still sitting on it.
  const scrimStops = /--brand-scrim:[\s\S]*?;/.exec(css)?.[0] ?? '';
  const alphas = [...scrimStops.matchAll(/rgba\(12,10,40,([\d.]+)\)/g)].map((m) => +m[1]);
  ok('the scrim was parsed', alphas.length >= 3, alphas.join(', '));

  // The headline occupies the top ~40% of the card, so it is covered by the
  // first two bands. The third and fourth exist only to fade the scrim out.
  const headlineAlpha = Math.min(alphas[0], alphas[1]);
  for (const [name, stop] of stops) {
    const scrimmed = over([12, 10, 40, headlineAlpha], stop);
    const r = contrast(light.get('--brand-ink'), scrimmed);
    ok(`headline over the scrim on ${name}`, r >= TEXT_MIN, `${r.toFixed(2)}:1`);
  }

  // The near-black call to action, which is the reference's most distinctive
  // borrowed element and the only button on the card.
  const cta = contrast(light.get('--on-brand-cta'), light.get('--brand-cta'));
  ok('the CTA label on near-black', cta >= TEXT_MIN, `${cta.toFixed(2)}:1`);
  ok('the CTA is not the accent',
    JSON.stringify(light.get('--brand-cta')) !== JSON.stringify(light.get('--accent')),
    'accent-on-indigo is blue on blue; the reference reaches for black and is right');
}

// ============================================================================
console.log('\n7. Icon chips carry their own ink');
// ============================================================================
//
// Amber, rose and teal are inherently light hues: a white glyph on #FFC95F is
// 1.76:1, and deepening them until white worked turned amber into mud. So each
// chip declares the ink that suits it. This checks nobody has since paired a
// pale fill with a white glyph.

for (const hue of ['blue', 'violet', 'green', 'teal', 'amber', 'rose']) {
  const gradient = new RegExp(`--chip-${hue}:linear-gradient\\([^,]+,([^,]+),([^)]+)\\)`).exec(css);
  const ink = parse(new RegExp(`--chip-${hue}-ink:(#[0-9a-fA-F]{6})`).exec(css)?.[1] ?? '');

  if (!gradient || !ink) { ok(`--chip-${hue} is defined`, false, 'missing'); continue; }

  const worst = Math.min(...[gradient[1], gradient[2]]
    .map((stop) => contrast(ink, parse(stop.trim()))));

  // Icons here are decorative (aria-hidden, with a text label beside them), so
  // the bar is the non-text 3:1 rather than 4.5:1 — but invisible is still
  // invisible, and a chip whose glyph vanishes looks broken rather than subtle.
  ok(`--chip-${hue} glyph is visible on both stops`, worst >= NON_TEXT_MIN, `${worst.toFixed(2)}:1`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
