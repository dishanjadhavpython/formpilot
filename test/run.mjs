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

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['crypto', 'PBKDF2 + AES-GCM, IV uniqueness, tamper detection'],
  ['match',  'field inference, specificity, refusal cases'],
  ['image',  'file-size band search, ladder descent, failure modes'],
  ['ocr',    'PAN / date / Aadhaar / name-line heuristics'],
  ['backup', 'export-import round trip, malformed-file rejection']
];

function run(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, `${name}.test.mjs`)], {
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
for (const [name, description] of SUITES) {
  const { code, out } = await run(name);
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
