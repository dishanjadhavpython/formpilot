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

  // "The encrypt cannot fail, why decrypt it again" - and the one time it does,
  // the user is left with a vault nothing can open.
  ['stops verifying a passphrase change before returning it', 'lib/crypto.js',
    (s) => s.replace('  await decryptVault(key, next);\n', '')],

  // "Reuse the salt, it is already random" - which lets one PBKDF2 run per
  // candidate test an old backup and the new record at once.
  // Anchored on the unlockVault call above it, because createVault opens with
  // the same two lines and comes first in the file - an unanchored replace
  // silently mutates the wrong function and proves nothing.
  ['reuses the old salt on a passphrase change', 'lib/crypto.js',
    (s) => s.replace(
      'const { data } = await unlockVault(currentPassphrase, record);\n\n  const salt = randomBytes(KDF.saltBytes);',
      'const { data } = await unlockVault(currentPassphrase, record);\n\n  const salt = base64ToBytes(record.kdf.salt);')],

  // The same regression one function up, where nothing was watching until now.
  ['gives every new vault the same fixed salt', 'lib/crypto.js',
    (s) => s.replace(
      'export async function createVault(passphrase, initialData) {\n  const salt = randomBytes(KDF.saltBytes);',
      'export async function createVault(passphrase, initialData) {\n  const salt = new Uint8Array(16);')],

  // Locking that leaves the whole original image on screen, under an object URL
  // that still resolves.
  ['leaves the crop preview up after locking', 'options.js',
    (s) => s.replace('  releaseCropPreview();\n', '')],

  // The passphrase the user just typed, left in the DOM of an unattended screen.
  ['leaves the passphrase boxes filled after locking', 'options.js',
    (s) => s.replace("  for (const id of ['cpCurrent', 'cpNew', 'cpConfirm']) $(id).value = '';\n", '')],

  // "The clean-up should just report progress like everything else" - and now a
  // module that handles a photograph of an ID card has a channel out of it.
  ['gives pre-processing a callback out', 'lib/preprocess.js',
    (s) => s.replace('export function preprocessForOcr(source, options = {}) {',
      'export function preprocessForOcr(source, options = {}, onProgress) {\n  onProgress?.(source);')],

  // "A clean-up failure means the image is bad, just surface the error" - which
  // turns an exotic file format into no OCR at all instead of slightly worse OCR.
  ['makes a clean-up failure abort the OCR run', 'lib/ocr.js',
    (s) => s.replace('    return { image: file, applied: null, note: null };', '    throw new Error("preprocessing failed");')],

  // "Skew is skew, why cap it" - and a portrait-orientation card gets a
  // confident 40-degree correction that destroys the reading.
  ['unbounds the skew search', 'lib/preprocess.js',
    (s) => s.replace('export const MAX_SKEW_DEGREES = 12;', 'const SKEW_LIMIT = 90;')],

  // Rotating onto a transparent canvas: the corners composite to black and the
  // engine reads a black frame as ink.
  ['rotates onto transparent corners', 'lib/preprocess.js',
    (s) => s.replace(
      "  const context = canvas.getContext('2d', { willReadFrequently: true });\n  context.fillStyle = '#ffffff';\n  context.fillRect(0, 0, width, height);\n\n  context.translate(",
      "  const context = canvas.getContext('2d', { willReadFrequently: true });\n\n  context.translate(")],

  // The EXIF orientation tag is the most common reason a phone photo arrives
  // sideways, and OCR on a sideways card reads nothing at all.
  ['gives OCR its own decoder again', 'lib/ocr.js',
    (s) => s.replace("import { decodeToCanvas } from './image.js';", 'const decodeToCanvas = (f) => createImageBitmap(f);')],

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
