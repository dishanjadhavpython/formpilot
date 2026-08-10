// FormPilot - run every automated check.
//
//   node test/run.mjs          all suites
//   node test/crypto.test.mjs  one suite, with its full output
//
// These exercise the pure logic — cryptography, field matching, the image band
// search, OCR heuristics, backup envelopes — under Node's Web Crypto, which is
// the same API the browser gives us. They deliberately do NOT cover anything
// DOM- or Chrome-shaped (script injection, canvas encoding, WASM, alarms);
// that still needs a real browser. See run.md.
//
// The last three are the security checks: what actually crosses into a web page
// and what happens when the extension is handed a hostile file (security), a
// static scan of the source for the rules in CLAUDE.md (audit), and a proof
// that the scan catches real regressions rather than reporting green forever
// (mutation). See SECURITY.md.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['crypto',   'crypto.test.mjs',   'PBKDF2 + AES-GCM, IV uniqueness, tamper detection'],
  ['match',    'match.test.mjs',    'field inference, specificity, refusal cases'],
  ['image',    'image.test.mjs',    'file-size band search, ladder descent, failure modes'],
  ['ocr',      'ocr.test.mjs',      'PAN / date / Aadhaar / name-line heuristics'],
  ['backup',   'backup.test.mjs',   'export-import round trip, malformed-file rejection'],
  ['security', 'security.test.mjs', 'what crosses into a page, hostile-file handling'],
  ['audit',    'audit.test.mjs',    'static scan: no network, no eval, no auto-submit'],
  ['mutation', 'audit-mutations.mjs', 'proves the audit above actually catches regressions'],
  ['package',  'package.test.mjs',  'the store ZIP: complete, minimal, reproducible']
];

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, file)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

let failed = 0;
let total = 0;

console.log('');
for (const [name, file, description] of SUITES) {
  const { code, out } = await run(file);
  const summary = out.trim().split('\n').at(-1) ?? '';
  const counts = /(\d+) passed, (\d+) failed/.exec(summary);
  if (counts) total += Number(counts[1]);

  const mark = code === 0 ? '  ok  ' : ' FAIL ';
  console.log(`${mark} ${name.padEnd(8)} ${(counts ? summary : 'no summary').padEnd(22)} ${description}`);

  if (code !== 0) {
    failed++;
    console.log(out.split('\n').filter((l) => l.includes('FAIL')).map((l) => `        ${l.trim()}`).join('\n'));
  }
}

console.log(`\n${failed === 0 ? `All suites passed — ${total} assertions.` : `${failed} suite(s) failed.`}\n`);
process.exit(failed ? 1 : 0);
