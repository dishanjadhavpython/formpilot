// FormPilot - does the security audit actually catch anything?
//
//   node test/audit-mutations.mjs
//
// A check that cannot fail is worse than no check: it reports green forever and
// buys false confidence. So this copies the project to a temp directory, breaks
// one security property at a time, and asserts the audit notices each one.
//
// Every mutation below is a real regression somebody could plausibly write:
// "just this one fetch", "the shadow root needs to be open so I can debug it",
// "1000 iterations is faster in development". Add a mutation whenever you add a
// check, or the check is decoration.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  ['adds a fetch() to lib/image.js', 'lib/image.js',
    (s) => s.replace('export async function fitToBand',
      'async function ping() { await fetch("https://x.test/log"); }\nexport async function fitToBand')],

  ['puts values back in the DETECT message', 'background.js',
    (s) => s.replace('keys: meta.keys,', 'keys: meta.keys,\n      fields: vaultData.fields ?? {},')],

  ['reopens the shadow root', 'content.js',
    (s) => s.replace("mode: 'closed'", "mode: 'open'")],

  ['drops the trusted-click check', 'content.js',
    (s) => s.replace('if (!event.isTrusted || !pendingMeta) return;', 'if (!pendingMeta) return;')],

  ['drops PBKDF2 to 1000 iterations', 'lib/crypto.js',
    (s) => s.replace('iterations: 310_000', 'iterations: 1_000')],

  ['makes the derived key extractable', 'lib/crypto.js',
    (s) => s.replace("{ name: 'AES-GCM', length: 256 },  // the key we actually want\n    false,",
      "{ name: 'AES-GCM', length: 256 },  // the key we actually want\n    true,")],

  ['stops skipping password fields', 'content.js',
    (s) => s.replace("'password', 'hidden'", "'hidden'")],

  ['auto-submits the form after filling', 'content.js',
    (s) => s.replace('    showToast(filled.length, grandTotal, skipped, filledDocs);',
      '    plan[0]?.el?.form?.submit();\n    showToast(filled.length, grandTotal, skipped, filledDocs);')],

  ['loses the OCR workerBlobURL override', 'lib/ocr.js',
    (s) => s.replace('workerBlobURL: false', 'workerBlobURL: true')],

  ['adds a "cookies" permission', 'manifest.json',
    (s) => s.replace('"alarms"]', '"alarms", "cookies"]')],

  ['loosens the CSP with unsafe-eval', 'manifest.json',
    (s) => s.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'")],

  ['exposes a web-accessible resource', 'manifest.json',
    (s) => s.replace('"externally_connectable"',
      '"web_accessible_resources": [{"resources": ["options.html"], "matches": ["<all_urls>"]}],\n  "externally_connectable"')],

  ['writes a fourth unencrypted local key', 'options.js',
    (s) => s.replace('await chrome.storage.local.set({ siteMappings: current });',
      'await chrome.storage.local.set({ plaintextVault: vault });')],

  ['builds markup out of a value', 'content.js',
    (s) => s.replace('note.textContent = detail;', 'note.innerHTML = `<b>${detail}</b>`;')],

  // "It needs <all_urls> anyway, why make people click twice" - which quietly
  // puts "read and change all your data on all websites" back in front of
  // every installer, including those who never turn detection on.
  ['makes <all_urls> a required permission again', 'manifest.json',
    (s) => s.replace('"optional_host_permissions": ["<all_urls>"]', '"host_permissions": ["<all_urls>"]')],

  // background.js keeps its own copy of expandValues. This is the plausible
  // version of that going wrong: someone simplifies one copy and not the other,
  // and detection starts disagreeing with what a fill writes.
  ['drifts the worker copy of expandValues', 'background.js',
    (s) => s.replace("values.middleName ??= parts.slice(1, -1).join(' ')", 'values.middleName ??= parts[1]')],

  // "The real matcher is awkward to call from a page, just hard-code what the
  // demo form should produce" - turning the one thing a hesitant user judges us
  // on into a scripted performance.
  ['turns the demo into a scripted fake', 'demo.js',
    (s) => s.replace('M.inferKey(haystack, dictionary)?.key', 'SCRIPTED[el.id]')],

  // The same lie, told only about the radio groups - which a whole-file grep
  // for "M.inferKey" would happily keep reporting green.
  ['fakes only the demo radio matching', 'demo.js',
    (s) => s.replace('M.chooseOption(value, els.map(radioOption))', 'SCRIPTED_INDEX')],

  // "Checkboxes are just another field, why not fill them too" - which is how
  // FormPilot ends up ticking "I hereby declare the above to be true".
  ['starts filling checkboxes', 'content.js',
    (s) => s.replace("'checkbox', 'radio', 'range', 'color'", "'radio', 'range', 'color'")],

  // The subtle one: reverting the option matcher to a substring pass, which
  // ticks Female for a user who stored Male.
  ['makes option matching a substring test again', 'lib/match.js',
    (s) => s.replace(
      'if (boundary.test(String(option?.text ?? \'\').trim().toLowerCase())) return i;',
      'if (String(option?.text ?? \'\').trim().toLowerCase().includes(want)) return i;')],

  // "category is a normal field, why restrict it" - and now a text box labelled
  // "Job Category" gets "OBC" typed into it.
  ['lets a choice-only key fill a free-text box', 'content.js',
    (s) => s.replace(
      "if (M.CHOICE_ONLY.has(key) && el.tagName.toLowerCase() !== 'select') {",
      'if (false) {')],

  // "The demo would be more convincing with the user's actual details in it."
  ['lets the demo read the unlocked vault', 'demo.js',
    (s) => s.replace(
      "const { settings } = await chrome.storage.local.get('settings');",
      "const { settings } = await chrome.storage.session.get('vaultData');")],

  // "Two round trips per keystroke of a shortcut is wasteful" - and collapsing
  // them means handing the page every value it might conceivably want.
  ['drops the PLAN pass from the keyboard shortcut', 'background.js',
    (s) => s.replace(
      "const plan = await chrome.tabs.sendMessage(tab.id, { type: 'PLAN', ...payload });",
      'const plan = { ok: true, count: 1, keys: meta.keys, docTypes: meta.docKeys };')],

  // The same regression by the other route: plan properly, then ignore it.
  ['sends the whole vault instead of the planned keys', 'background.js',
    (s) => s.replace(
      'const { values, docs } = narrow(vaultData, plan.keys, plan.docTypes);',
      'const values = expandValues(vaultData); const docs = {};')]
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'formpilot-audit-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));

// vendor/ is megabytes of minified library and the audit never reads it.
fs.cpSync(ROOT, work, {
  recursive: true,
  filter: (src) => !/(^|\/)(\.git|node_modules|vendor)$/.test(src)
});

let caught = 0;
let broken = 0;

for (const [label, file, mutate] of MUTATIONS) {
  const target = path.join(work, file);
  const original = fs.readFileSync(target, 'utf8');
  const patched = mutate(original);

  if (patched === original) {
    // The mutation no longer applies, which means the code it targeted has been
    // rewritten - so this check is no longer proven to work.
    console.log(`  STALE   ${label.padEnd(42)} mutation did not apply to ${file}`);
    broken++;
    continue;
  }

  fs.writeFileSync(target, patched);
  let noticed = false;
  let which = '';
  try {
    execFileSync(process.execPath, [path.join(work, 'test/audit.test.mjs')], { stdio: 'pipe' });
  } catch (err) {
    noticed = true;
    which = (err.stdout.toString().match(/^ {2}FAIL.*$/m) ?? [''])[0].trim().replace(/\s+->.*$/, '');
  }
  fs.writeFileSync(target, original);

  console.log(`  ${noticed ? 'caught ' : 'MISSED '} ${label.padEnd(42)} ${which}`);
  noticed ? caught++ : broken++;
}

console.log(`\n${caught} passed, ${broken} failed`);
process.exit(broken ? 1 : 0);
