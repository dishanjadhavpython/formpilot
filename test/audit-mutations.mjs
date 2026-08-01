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
    (s) => s.replace('    showToast(filled.length, total, skipped);',
      '    el.form.submit();\n    showToast(filled.length, total, skipped);')],

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
    (s) => s.replace('note.textContent = detail;', 'note.innerHTML = `<b>${detail}</b>`;')]
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
