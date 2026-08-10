// FormPilot - static security audit.
//
//   node test/audit.test.mjs
//
// The other suites check that the code does what it should. This one checks
// that it never starts doing something it must not - it reads the source and
// asserts the rules in CLAUDE.md are still true of the file on disk.
//
// It exists because every rule here is one that stays satisfied for months and
// then quietly breaks in a single line: a `fetch` added for "just this one
// thing", an `innerHTML` that was fine until it interpolated a value, a
// permission added while debugging. A grep is a poor code reviewer but a very
// good tripwire, and it runs in half a second on every commit.
//
// A failure here is not a style opinion. Each one is a specific, named way this
// extension could leak data or attack its user.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Our own code. Vendored libraries are audited separately, by hand, and the
// findings are written up in vendor/README.md - grepping a minified bundle
// produces noise, not safety.
const FIRST_PARTY = [
  'background.js', 'content.js', 'popup.js', 'options.js',
  'lib/crypto.js', 'lib/match.js', 'lib/image.js', 'lib/ocr.js', 'lib/backup.js'
];

const sources = Object.fromEntries(FIRST_PARTY.map((file) => [file, read(file)]));
const manifest = JSON.parse(read('manifest.json'));

// These files describe the things they are forbidden to do, at length, in
// comments - "no .click() on a submit button" is itself a match for `.click(`.
// So every check runs against the source with whole-line comments blanked out,
// keeping the line count so multi-line patterns still line up.
const stripComments = (text) => text.split('\n')
  .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
  .join('\n');

const code = Object.fromEntries(
  Object.entries(sources).map(([file, text]) => [file, stripComments(text)])
);

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

/** Every first-party file must be clean of `pattern`. */
function noneContain(name, pattern, why) {
  const hits = [];
  for (const [file, text] of Object.entries(code)) {
    for (const [i, line] of text.split('\n').entries()) {
      if (pattern.test(line)) hits.push(`${file}:${i + 1}`);
    }
  }
  ok(name, hits.length === 0, hits.length ? `${why} — ${hits.join(', ')}` : '');
}

const has = (file, pattern) => pattern.test(code[file]);

// ============================================================================
console.log('\n1. No network. The whole privacy claim rests on this one.');
// ============================================================================

noneContain('no fetch()', /\bfetch\s*\(/, 'a network call');
noneContain('no XMLHttpRequest', /\bXMLHttpRequest\b/, 'a network call');
noneContain('no WebSocket', /\bnew\s+WebSocket\b/, 'a network call');
noneContain('no sendBeacon', /\bsendBeacon\s*\(/, 'exfiltration by beacon');
noneContain('no EventSource', /\bnew\s+EventSource\b/, 'a server-sent-events stream');
noneContain('no importScripts', /\bimportScripts\s*\(/, 'remote code');

// A remote URL in first-party code is either a fetch waiting to happen or a
// vendored path that escaped. The two Web Store URLs in popup.js are string
// comparisons against the current tab, never navigations.
{
  const allowed = /chromewebstore\.google\.com|chrome\.google\.com\/webstore/;
  const hits = [];
  for (const [file, text] of Object.entries(code)) {
    for (const [i, line] of text.split('\n').entries()) {
      const found = line.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
      for (const url of found) if (!allowed.test(url)) hits.push(`${file}:${i + 1} ${url}`);
    }
  }
  ok('no remote URLs in code', hits.length === 0, hits.join(', '));
}

// ============================================================================
console.log('\n2. No remote or dynamic code (MV3 requirement)');
// ============================================================================

noneContain('no eval()', /(^|[^.\w])eval\s*\(/, 'arbitrary code execution');
noneContain('no new Function()', /\bnew\s+Function\s*\(/, 'arbitrary code execution');
noneContain('no setTimeout("string")', /setTimeout\s*\(\s*['"`]/, 'string-eval by another name');
noneContain('no blob: workers', /new\s+Worker\s*\(\s*URL\.createObjectURL/, 'blob workers dodge CSP');

// Quoted, because 'wasm-unsafe-eval' contains the substring "unsafe-eval" and a
// naive check flags the one directive we actually need.
ok('CSP has no unsafe-eval',
  !manifest.content_security_policy.extension_pages.includes("'unsafe-eval'"));
ok('CSP keeps wasm-unsafe-eval (OCR needs it)',
  manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"));

for (const directive of ['default-src', 'connect-src', 'object-src', 'frame-src', 'base-uri', 'form-action']) {
  ok(`CSP sets ${directive}`, manifest.content_security_policy.extension_pages.includes(directive));
}
ok("CSP pins connect-src to 'self'",
  /connect-src 'self'/.test(manifest.content_security_policy.extension_pages),
  'this is what makes "no network" a policy, not just a promise');

// ============================================================================
console.log('\n3. Never auto-submit a form');
// ============================================================================

noneContain('no form.submit()', /\.submit\s*\(\s*\)/, 'submitting for the user');
noneContain('no requestSubmit()', /\.requestSubmit\s*\(/, 'submitting for the user');
noneContain('no synthetic Enter', /key:\s*['"]Enter['"]/, 'Enter can submit a form');
noneContain('no KeyboardEvent synthesis', /new\s+KeyboardEvent/, 'Enter can submit a form');

// .click() on a page element is the same thing wearing a hat. The options page
// clicks its OWN buttons, which is fine; the content script must never click
// anything on somebody else's page.
ok('content.js clicks nothing on the page', !has('content.js', /\.click\s*\(\s*\)/),
  'a click on the page could be a submit button');

// ============================================================================
console.log('\n4. Never fill password fields, or anyone else\'s');
// ============================================================================

ok('password is in SKIP_TYPES', /SKIP_TYPES[\s\S]{0,200}'password'/.test(code['content.js']));
ok('NEVER refuses otp / captcha', /NEVER\s*=[\s\S]{0,400}(captcha|otp)/.test(code['lib/match.js']));
ok('THIRD_PARTY guard exists', /const THIRD_PARTY\s*=\s*\//.test(code['lib/match.js']));
ok('THIRD_PARTY is enforced in inferKey',
  /minimumPriority\s*=\s*THIRD_PARTY\.test/.test(code['lib/match.js']));
ok('honeypots are refused',
  /docRight\s*<=\s*0\s*\|\|\s*docBottom\s*<=\s*0/.test(code['content.js']),
  'off-screen fields are how a form detects a bot');

// ============================================================================
console.log('\n5. Vault data never reaches a web page unasked');
// ============================================================================

// The DETECT message goes to every http(s) page you open while unlocked. If it
// ever carries values again, browsing becomes broadcasting.
{
  const detect = /type:\s*'DETECT'[\s\S]{0,400}?\}\)/.exec(code['background.js'])?.[0] ?? '';
  ok('DETECT message is built', detect.length > 0);
  ok('DETECT carries no fields:', !/\bfields:/.test(detect), detect.slice(0, 80));
  ok('DETECT carries no values:', !/\bvalues:/.test(detect));
  ok('DETECT carries no dataUrl:', !/\bdataUrl:/.test(detect),
    'documents get the same treatment as text values - types and mimes only');
  ok('DETECT carries key names only', /\bkeys:\s*meta\.keys/.test(detect));
  ok('DETECT carries document types only', /\bdocKeys:\s*meta\.docKeys/.test(detect));
}

{
  const describeDocs = /function describeDocs\([\s\S]{0,600}?\n  \}/.exec(code['lib/match.js'])?.[0] ?? '';
  ok('describeDocs is defined', describeDocs.length > 0);
  ok('describeDocs returns docKeys/docMimes',
    /return\s*\{\s*docKeys,\s*docMimes\s*\}/.test(describeDocs));
  ok('describeDocs never returns dataUrl',
    !/return[\s\S]*dataUrl/.test(describeDocs),
    'documents get the same "names/labels only" treatment text fields already have');
}

ok('describeVault strips values',
  /function describeVault[\s\S]{0,600}keys:\s*Object\.keys/.test(code['lib/match.js']));
ok('the popup plans before it fills',
  /type:\s*'PLAN'/.test(code['popup.js']),
  'pass 1 sends key names, pass 2 sends only the values that pass planned');
ok('the popup narrows values with pickValues',
  /values:\s*M\.pickValues/.test(code['popup.js']));
ok('TEACH carries key names only',
  /type:\s*'TEACH',\s*keys:/.test(code['popup.js']));

// ============================================================================
console.log('\n6. The page cannot drive the extension');
// ============================================================================

ok('the in-page UI uses a CLOSED shadow root',
  /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/.test(code['content.js']),
  'an open root lets the page click our Fill button itself');
ok('the chip requires a trusted click',
  /if\s*\(!event\.isTrusted/.test(code['content.js']),
  'element.click() from the page produces isTrusted:false');
ok('content.js checks the sender', /sender\?\.id === chrome\.runtime\.id/.test(code['content.js']));
ok('background.js checks the sender', /sender\?\.id === chrome\.runtime\.id/.test(code['background.js']));
ok('ACTIVITY is refused from a page',
  /case 'ACTIVITY':[\s\S]{0,300}fromExtensionPage\(sender\)/.test(code['background.js']),
  'otherwise a busy page could hold the vault unlocked forever');
ok('externally_connectable blocks other extensions',
  Array.isArray(manifest.externally_connectable?.ids) && manifest.externally_connectable.ids.length === 0);
ok('nothing is web-accessible',
  manifest.web_accessible_resources === undefined,
  'a web_accessible_resource is a page any site can load');
ok('content.js is injected, never declared',
  manifest.content_scripts === undefined,
  'a declared content script runs everywhere, always');

// ============================================================================
console.log('\n7. Nothing personal is written unencrypted');
// ============================================================================

{
  // Only three keys may ever be written to chrome.storage.local, and each is
  // justified in CLAUDE.md. A fourth needs a decision, not a diff.
  const ALLOWED = new Set(['[STORAGE_KEY]', 'settings', 'siteMappings']);
  const written = new Set();
  for (const text of Object.values(code)) {
    for (const match of text.matchAll(/chrome\.storage\.local\.set\(\{\s*(\[?[A-Za-z_$][\w$]*\]?)/g)) {
      written.add(match[1]);
    }
  }
  const unexpected = [...written].filter((key) => !ALLOWED.has(key));
  ok('only the three known local keys are written', unexpected.length === 0,
    unexpected.length ? `unexpected: ${unexpected.join(', ')}` : [...written].join(', '));
}

ok('session storage is pinned to trusted contexts',
  /setAccessLevel\(\{\s*accessLevel:\s*'TRUSTED_CONTEXTS'/.test(code['background.js']),
  'otherwise a content script could read the unlocked vault');

// innerHTML is allowed only for a fixed string. The moment it interpolates, it
// is one vault value away from being an injection.
{
  const hits = [];
  for (const [file, text] of Object.entries(code)) {
    for (const match of text.matchAll(/innerHTML\s*=\s*([\s\S]*?);\n/g)) {
      if (/\$\{/.test(match[1])) hits.push(file);
    }
  }
  ok('no innerHTML with interpolation', hits.length === 0, hits.join(', '));
}
noneContain('no insertAdjacentHTML', /insertAdjacentHTML/, 'same risk as innerHTML');
noneContain('no document.write', /document\.write/, 'same risk as innerHTML');

// ============================================================================
console.log('\n8. Crypto parameters have not drifted');
// ============================================================================

{
  const crypto = code['lib/crypto.js'];
  const iterations = Number(/iterations:\s*([\d_]+)/.exec(crypto)?.[1].replace(/_/g, ''));
  ok('PBKDF2 iterations >= 150,000', iterations >= 150_000, String(iterations));
  ok('SHA-256', /hash:\s*'SHA-256'/.test(crypto));
  ok('AES-GCM 256', /name:\s*'AES-GCM',\s*length:\s*256/.test(crypto));
  ok('IV is 96 bits', /IV_BYTES\s*=\s*12/.test(crypto));
  ok('salt is >= 16 bytes', Number(/saltBytes:\s*(\d+)/.exec(crypto)?.[1]) >= 16);

  // The single most dangerous possible regression in this file.
  ok('encryptVault generates its own IV',
    /export async function encryptVault[\s\S]{0,400}const iv = randomBytes\(IV_BYTES\)/.test(crypto),
    'reusing an IV under one key breaks GCM outright');
  ok('encryptVault accepts no IV parameter',
    /export async function encryptVault\(key, data, kdfParams\)/.test(crypto),
    'a caller-supplied IV is a caller-supplied bug');

  ok('the derived key is non-extractable',
    /\{ name: 'AES-GCM', length: 256 \}[\s\S]{0,120}false,/.test(crypto),
    'an extractable key can be exported, logged and stored');
  ok('no password hash is stored', !/passwordHash|verifier/.test(crypto));
}

// ============================================================================
console.log('\n9. OCR stays on-device');
// ============================================================================

{
  const ocr = code['lib/ocr.js'];
  for (const option of ['workerPath', 'corePath', 'langPath']) {
    ok(`${option} is overridden`, new RegExp(`${option}:`).test(ocr),
      'losing one silently restores a CDN fetch');
  }
  ok('workerBlobURL: false', /workerBlobURL:\s*false/.test(ocr));
  ok('all three paths are local', !/cdn\.|unpkg|jsdelivr/.test(ocr.replace(/^\s*\/\/.*$/gm, '')));
}

// ============================================================================
console.log('\n10. Permissions have not grown');
// ============================================================================

{
  const EXPECTED = ['storage', 'activeTab', 'scripting', 'alarms'];
  const extra = manifest.permissions.filter((p) => !EXPECTED.includes(p));
  const missing = EXPECTED.filter((p) => !manifest.permissions.includes(p));
  ok('permissions are exactly the four expected', extra.length === 0 && missing.length === 0,
    [...extra.map((p) => `+${p}`), ...missing.map((p) => `-${p}`)].join(' '));

  for (const risky of ['tabs', 'webRequest', 'cookies', 'history', 'downloads', 'nativeMessaging', 'debugger']) {
    ok(`no "${risky}" permission`, !manifest.permissions.includes(risky));
  }
  // <all_urls> must stay OPTIONAL. Declared as a required host permission, the
  // install prompt reads "Read and change all your data on all websites" for
  // every user - including everyone who never turns detection on. Filling on
  // click runs on activeTab and needs no standing access at all.
  ok('no required host_permissions at install',
    manifest.host_permissions === undefined,
    'a required <all_urls> is the scariest install prompt Chrome shows');
  ok('optional_host_permissions is exactly <all_urls>',
    JSON.stringify(manifest.optional_host_permissions) === '["<all_urls>"]',
    'requested from the suggest-fills toggle, never at install');
  ok('detection checks the permission before scripting a page',
    /hasBroadHostAccess\(\)/.test(code['background.js']),
    'the grant can be revoked from chrome://extensions without telling us');
  ok('releasing values re-checks the permission',
    /async function releaseFill[\s\S]{0,400}hasBroadHostAccess\(\)/.test(code['background.js']),
    'a revoke between the scan and the click must stop the fill');
}

// ============================================================================
console.log('\n11. The duplicated expandValues has not drifted');
// ============================================================================
//
// background.js keeps its own copy of lib/match.js's expandValues, because the
// worker is an ES module and match.js is a classic script for the content
// script's world. The reason is sound; the risk is that the copies diverge and
// nothing says so. If they do, the badge count from detection stops agreeing
// with what a fill actually writes - an intermittent bug in the one code path
// that is hardest to watch.
//
// So this does not compare text. It lifts the worker's copy out of the source,
// runs both against the same fixtures, and asserts identical output.

{
  const source = sources['background.js'];
  const start = source.indexOf('function expandValues(vaultData)');
  ok('background.js still defines its own expandValues', start !== -1);

  if (start !== -1) {
    // Balance braces from the function's opening { to find where it ends.
    let depth = 0, end = -1;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
    }

    const workerCopy = new Function(`${source.slice(start, end)}; return expandValues;`)();
    vm.runInThisContext(read('lib/match.js'));
    const M = globalThis.FormPilotMatch;

    // Each fixture targets one branch the two copies both implement: name
    // splitting, the labelled-email keys, the alternate-email fallback, the
    // no-primary-email fallback, custom fields, and empty-value stripping.
    const FIXTURES = [
      { fields: {}, customFields: [], emails: [] },
      { fields: { fullName: 'Prince' }, customFields: [], emails: [] },
      { fields: { fullName: 'Dishan Jadhav' }, customFields: [], emails: [] },
      { fields: { fullName: 'A B C D', firstName: 'Zed' }, customFields: [], emails: [] },
      { fields: { email: 'main@me.test', phone: '', pan: 'ABCDE1234F' }, customFields: [], emails: [] },
      { fields: {}, customFields: [], emails: [{ label: 'work', value: 'w@me.test' }] },
      { fields: { email: 'main@me.test' }, customFields: [],
        emails: [{ label: 'work', value: 'w@me.test' }, { label: 'college', value: 'c@me.test' }] },
      { fields: {}, customFields: [], emails: [{ label: 'work', value: '' }] },
      { fields: { fullName: 'A B' }, customFields: [{ label: 'Employee ID', value: 'E-9' }], emails: [] },
      { fields: { fullName: 'A B' }, customFields: [{ label: 'Blank', value: '' }], emails: [] }
    ];

    const drifted = [];
    for (const [i, v] of FIXTURES.entries()) {
      const fromWorker = workerCopy(v);
      const fromLib = M.expandValues(v.fields, v.customFields, v.emails);
      if (JSON.stringify(fromWorker) !== JSON.stringify(fromLib)) {
        drifted.push(`#${i}: worker ${JSON.stringify(fromWorker)} vs lib ${JSON.stringify(fromLib)}`);
      }
    }
    ok('both copies agree on every fixture', drifted.length === 0, drifted.join(' | '));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
