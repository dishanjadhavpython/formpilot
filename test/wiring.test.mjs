// FormPilot - is every page actually wired to its script?
//
//   node test/wiring.test.mjs
//
// These pages call $('someId') at module top level. One missing id throws
// before anything else runs, and the whole page is dead - a blank options page,
// no vault, no error the user can act on. Nothing else in the suite catches
// that, because every other suite tests logic that never touches the DOM.
//
// It is exactly the failure a refactor causes: rename an element in the HTML,
// miss one reference in the JS, and every test still passes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const PAGES = [
  { html: 'options.html', js: 'options.js' },
  { html: 'popup.html',   js: 'popup.js' },
  { html: 'demo.html',    js: 'demo.js' },
  { html: 'welcome.html', js: 'welcome.js' }
];

const idsIn = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

// ============================================================================
console.log('\n1. Every id a script reaches for exists in its page');
// ============================================================================

for (const page of PAGES) {
  const ids = idsIn(read(page.html));
  const js = read(page.js);

  const wanted = new Set([
    ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
  ]);

  const missing = [...wanted].filter((id) => !ids.has(id));
  ok(`${page.js} -> ${page.html}`, missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${wanted.size} ids, all present`);
}

// ============================================================================
console.log('\n2. No duplicate ids');
// ============================================================================

for (const page of [...PAGES.map((p) => p.html), 'test/form.html']) {
  const all = [...read(page).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const duplicates = all.filter((id, i) => all.indexOf(id) !== i);
  ok(page, duplicates.length === 0,
    duplicates.length ? `duplicated: ${[...new Set(duplicates)].join(', ')}` : `${all.length} unique`);
}

// ============================================================================
console.log('\n3. Every <label for=...> points at a real control');
// ============================================================================
//
// A label pointing at nothing is a label that does not focus its field on
// click and does not announce it to a screen reader.

for (const page of [...PAGES.map((p) => p.html), 'test/form.html']) {
  const html = read(page);
  const ids = idsIn(html);
  const orphans = [...html.matchAll(/<label[^>]+for="([^"]+)"/g)]
    .map((m) => m[1]).filter((id) => !ids.has(id));
  ok(page, orphans.length === 0, orphans.length ? `dangling: ${orphans.join(', ')}` : 'all resolve');
}

// ============================================================================
console.log('\n4. Every referenced file exists');
// ============================================================================

{
  const broken = [];
  for (const page of PAGES.map((p) => p.html)) {
    const html = read(page);
    const refs = [
      ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
      ...html.matchAll(/<link[^>]+href="([^"]+)"/g),
      ...html.matchAll(/<img[^>]+src="([^"]+)"/g)
    ].map((m) => m[1]);

    for (const ref of refs) {
      if (/^(https?:|data:|#)/.test(ref)) continue;
      if (!fs.existsSync(path.join(ROOT, path.dirname(page), ref))) broken.push(`${page} -> ${ref}`);
    }
  }
  ok('stylesheets, scripts and images resolve', broken.length === 0, broken.join(', '));
}

{
  const SOURCES = ['options.js', 'popup.js', 'demo.js', 'welcome.js', 'background.js',
    'lib/crypto.js', 'lib/match.js', 'lib/image.js', 'lib/ocr.js', 'lib/backup.js',
    'lib/preprocess.js'];

  const broken = [];
  for (const file of SOURCES) {
    for (const m of read(file).matchAll(/from\s+'([^']+)'/g)) {
      if (!m[1].startsWith('.')) continue;
      if (!fs.existsSync(path.join(ROOT, path.dirname(file), m[1]))) broken.push(`${file} -> ${m[1]}`);
    }
  }
  ok('every relative import resolves', broken.length === 0, broken.join(', '));
}

// ============================================================================
console.log('\n5. Every CSS custom property used is defined');
// ============================================================================
//
// An undefined var() silently resolves to nothing, so the rule is dropped and
// the element renders unstyled rather than wrong - which is easy to miss in a
// section you were not looking at.

{
  const css = ['styles/one-ui.css', 'styles/liquid-glass.css'].map(read).join('\n')
    + PAGES.map((p) => read(p.html)).join('\n');

  // Several tokens per line is the house style, so this is not line-anchored.
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const undefinedVars = [...used].filter((name) => !defined.has(name));

  ok('no undefined custom properties', undefinedVars.length === 0,
    undefinedVars.length ? undefinedVars.join(', ') : `${used.size} used, ${defined.size} defined`);
}

// ============================================================================
console.log('\n6. Every class toggled from JS has a rule somewhere');
// ============================================================================

{
  // content.js styles its own closed shadow root from a string inside itself,
  // so it counts as a stylesheet here.
  const css = ['styles/one-ui.css', 'styles/liquid-glass.css', 'content.js']
    .map(read).join('\n') + PAGES.map((p) => read(p.html)).join('\n');

  const orphans = [];
  for (const file of [...PAGES.map((p) => p.js), 'content.js']) {
    const js = read(file);
    const toggled = new Set([...js.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'/g)]
      .map((m) => m[1]));
    for (const name of toggled) if (!css.includes(`.${name}`)) orphans.push(`${file}: .${name}`);
  }
  ok('no class is toggled without a rule', orphans.length === 0, orphans.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
