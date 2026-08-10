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
  'background.js', 'content.js', 'popup.js', 'options.js', 'welcome.js', 'demo.js',
  'lib/crypto.js', 'lib/match.js', 'lib/image.js', 'lib/ocr.js', 'lib/backup.js',
  'lib/preprocess.js'
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

  // A fixed or predictable salt lets one precomputed table crack every vault at
  // once, which is the entire thing a salt exists to prevent.
  ok('createVault generates a random salt',
    /export async function createVault[\s\S]{0,200}const salt = randomBytes\(KDF\.saltBytes\)/.test(crypto),
    'a fixed salt makes one precomputed table crack every vault');
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

// ============================================================================
console.log('\n12. The demo demonstrates, and does not simulate');
// ============================================================================
//
// demo.html fills a pretend form in front of somebody deciding whether to trust
// this extension with their identity documents. If its decisions came from a
// hand-written script of plausible-looking outcomes, that display would be a
// lie - and a lie told at exactly the moment trust is being extended.
//
// So the demo must run the real matcher. These checks are what stop it quietly
// becoming a mock-up the day someone finds the real one inconvenient.

{
  const demo = code['demo.js'];
  ok('the demo uses the real matcher', /globalThis\.FormPilotMatch/.test(demo),
    'a demo that fakes its output is a lie told to earn trust');
  for (const call of ['inferKey', 'describeField', 'expandValues', 'buildDictionary']) {
    ok(`the demo calls the real ${call}()`, new RegExp(`M\\.${call}\\(`).test(demo));
  }
  ok('the demo explains refusals from the real guards',
    /M\.NEVER\.test/.test(demo) && /M\.THIRD_PARTY\.test/.test(demo),
    'the refusals are the persuasive half; they must be genuine');

  // Scoped per call site, not just "does M.inferKey appear anywhere". The demo
  // has two independent decision paths - text fields and radio groups - and a
  // whole-file grep would keep passing while one of them was quietly faked.
  {
    const judgeFn = /function judge\(el, dictionary\)[\s\S]*?\n\}/.exec(demo)?.[0] ?? '';
    ok('judge() is defined', judgeFn.length > 0);
    ok('text fields are judged by the real matcher', /M\.inferKey\(/.test(judgeFn));

    const fillHandler = /getElementById\('fillBtn'\)\.addEventListener[\s\S]*?\n\}\);/.exec(demo)?.[0] ?? '';
    ok('the fill handler is defined', fillHandler.length > 0);
    ok('radio groups are matched by the real matcher', /M\.inferKey\(/.test(fillHandler));
    ok('radio options are resolved by the real chooser', /M\.chooseOption\(/.test(fillHandler),
      'otherwise the demo picks an option the real extension would not');
  }

  ok('the demo shows a checkbox being refused',
    /declaration:/.test(demo) && /input\[type=checkbox\]/.test(demo),
    'the refusal is the most surprising thing FormPilot does; show it');

  // The whole promise of the demo is that it costs the user nothing. Reading a
  // real vault would break that promise even if it only ever displayed it.
  for (const [name, file] of [['demo.js', demo], ['welcome.js', code['welcome.js']]]) {
    ok(`${name} never reads the vault record`,
      !/storage\.local\.get\(\s*['"`]vault/.test(file));
    ok(`${name} never reads the unlocked session copy`,
      !/storage\.session/.test(file));
    ok(`${name} writes no storage at all`, !/storage\.\w+\.set\(/.test(file));
  }
  ok('the demo hard-codes an obviously fake identity',
    /example\.com/.test(demo) && !/@gmail|@yahoo|@outlook/.test(demo));
  ok('the demo masks its sample Aadhaar like the vault does',
    /aadhaarMasked:\s*['"`]X{4}/.test(demo),
    'even the fake one shows only the last four digits');
}

// ============================================================================
console.log('\n13. The keyboard shortcut takes no shortcuts');
// ============================================================================
//
// Ctrl+Shift+F reaches a page without going through the popup, so it is a
// second door into the same room and must obey the same rules.

{
  const worker = code['background.js'];
  const fillFn = /async function fillActiveTab\(\)[\s\S]*?\n\}/.exec(worker)?.[0] ?? '';

  ok('fillActiveTab is defined', fillFn.length > 0);
  ok('it refuses to run on a locked vault',
    /if \(!vaultData\)/.test(fillFn), 'a shortcut is not an unlock');
  ok('it checks the page is http(s)',
    /\^https\?:/.test(fillFn), 'never chrome://, never the Web Store');
  ok('it plans before it fills',
    fillFn.indexOf("type: 'PLAN'") !== -1
    && fillFn.indexOf("type: 'PLAN'") < fillFn.indexOf("type: 'FILL'"),
    'one message would mean handing the page the whole vault to pick from');
  ok('it narrows values to the plan',
    /narrow\(vaultData, plan\.keys, plan\.docTypes\)/.test(fillFn),
    'the same narrowing the chip path uses, not a second copy');
  ok('the PLAN it sends carries no values',
    !/type: 'PLAN'[\s\S]{0,200}values:/.test(fillFn));
  ok('the command is registered for fill-form only',
    /command === 'fill-form'/.test(worker));
  ok('manifest declares the fill-form command',
    Object.keys(manifest.commands ?? {}).join(',') === 'fill-form',
    JSON.stringify(Object.keys(manifest.commands ?? {})));
}

// ============================================================================
console.log('\n14. The welcome page opens once, on a real install');
// ============================================================================

ok('welcome.html is opened on install',
  /reason === 'install'[\s\S]{0,200}welcome\.html/.test(code['background.js']),
  'not on update, not on every service-worker wake');

// ============================================================================
console.log('\n15. Choice fields: never consent, never guess an option');
// ============================================================================

{
  const content = code['content.js'];
  const match = code['lib/match.js'];

  // A checkbox on these forms is overwhelmingly a statement the user is making
  // - "I hereby declare", "I accept the terms". Ticking one asserts it on their
  // behalf, which is the same category of act as pressing Submit for them.
  ok('checkbox stays in SKIP_TYPES',
    /SKIP_TYPES[\s\S]{0,400}'checkbox'/.test(content),
    'ticking a declaration is consenting on the user’s behalf');
  {
    // Exactly one place may tick anything, and it is reachable only from the
    // radio path. A stray `el.checked = true` elsewhere is how a checkbox ends
    // up ticked by accident.
    const helper = /function setNativeChecked\([\s\S]*?\n  \}/.exec(content)?.[0] ?? '';
    ok('setNativeChecked is defined', helper.length > 0);
    const elsewhere = content.replace(helper, '');
    ok('nothing ticks anything outside setNativeChecked',
      !/\.checked\s*=[^=]/.test(elsewhere),
      'one door, and only radios have the key');
  }
  ok('radios are never filled by clicking',
    !/\.click\s*\(/.test(content),
    'a click on the page could reach a submit button');

  // A radio is only ever ticked when the vault value matches one of the offered
  // options, so a wrong guess about which question a group is asking is inert.
  ok('radio filling goes through chooseOption',
    /M\.chooseOption\(value, els\.map\(radioOption\)\)/.test(content));
  ok('a group with no matching option is left alone',
    /if \(index < 0\) continue;/.test(content));

  // The bug this replaced: 'female'.includes('male') is true, so a substring
  // pass ticks Female for a user who stored Male.
  const chooseOption = /function chooseOption\([\s\S]*?\n  \}/.exec(match)?.[0] ?? '';
  ok('chooseOption is defined', chooseOption.length > 0);
  ok('chooseOption matches on word boundaries, not substrings',
    /\\\\b\$\{want/.test(chooseOption) && !/\.includes\(/.test(chooseOption),
    "'female'.includes('male') is true — a substring pass ticks the wrong option");

  ok('CHOICE_ONLY exists', /const CHOICE_ONLY\s*=\s*new Set/.test(match));
  ok('CHOICE_ONLY is enforced against free-text inputs',
    /M\.CHOICE_ONLY\.has\(key\)[\s\S]{0,120}!==\s*'select'/.test(content),
    '"OBC" typed into a free-text "Job Category" box is wrong, not merely useless');
}

// ============================================================================
console.log('\n16. Changing a passphrase cannot strand the vault');
// ============================================================================

{
  const crypto = code['lib/crypto.js'];
  const options = code['options.js'];
  const change = /export async function changePassphrase\([\s\S]*?\n\}/.exec(crypto)?.[0] ?? '';

  ok('changePassphrase is defined', change.length > 0);
  ok('it authorises with the current passphrase',
    /unlockVault\(currentPassphrase, record\)/.test(change),
    'being unlocked is not authorisation — an unattended machine is also unlocked');
  ok('it rotates the salt',
    /randomBytes\(KDF\.saltBytes\)/.test(change),
    'one PBKDF2 run must not test a candidate against an old backup and the new record at once');

  // The dangerous version writes a new record and then finds it will not open.
  ok('it decrypts what it produced before returning it',
    /await decryptVault\(key, next\)/.test(change),
    'a half-applied change is an unopenable vault — worse than no change');
  ok('the verification comes after the encrypt',
    change.indexOf('encryptVault') < change.indexOf('decryptVault(key, next)'));
  ok('changePassphrase writes nothing itself',
    !/chrome\.storage/.test(change),
    'the caller persists, and only a record already proven to open');

  // The re-encryption works from the record on DISK, so an unsaved edit in the
  // form would be silently thrown away.
  ok('the UI refuses to change over unsaved edits',
    /changePassBtn[\s\S]{0,900}if \(dirty\)/.test(options));
  ok('the UI adopts the new key and params',
    /sessionKey = changed\.key[\s\S]{0,120}kdfParams = changed\.kdfParams/.test(options),
    'otherwise the next Save re-encrypts under the passphrase that was just replaced');
}

// ============================================================================
console.log('\n17. Cropping, and what locking has to clear');
// ============================================================================

{
  const image = code['lib/image.js'];
  const options = code['options.js'];

  ok('planCrop is exported', /export function planCrop\(/.test(image));
  ok('ASPECT_PRESETS is exported', /export const ASPECT_PRESETS/.test(image));

  // Scaling pixels that are about to be discarded is waste; worse, it makes
  // maxWidthOrHeight apply to an edge the output does not have.
  ok('the crop happens before the resize',
    image.indexOf('const source = cropCanvas(decoded, crop)') > 0
    && image.indexOf('const source = cropCanvas(decoded, crop)') < image.indexOf('SCALE_LADDER) {'));
  ok('an uncropped image is not redrawn for nothing',
    /if \(rect\.width === source\.width[\s\S]{0,160}return source;/.test(image));

  // CLAUDE.md: locking must clear every trace derived from a document. The crop
  // stage shows the FULL uncropped image and holds its own object URL.
  const lock = /function lockLocally\(\)[\s\S]*?\n\}/.exec(options)?.[0] ?? '';
  ok('lockLocally is defined', lock.length > 0);
  ok('locking releases the crop preview', /releaseCropPreview\(\)/.test(lock),
    'it holds an object URL of the whole original image');
  ok('locking hides the crop stage', /cropBox'\)\.classList\.add\('hidden'\)/.test(lock));
  ok('locking clears the passphrase boxes',
    /cpCurrent', 'cpNew', 'cpConfirm'/.test(lock),
    'an idle lock must not leave a passphrase sitting in the DOM of an unattended screen');
  ok('releaseCropPreview revokes the URL',
    /function releaseCropPreview[\s\S]{0,240}URL\.revokeObjectURL/.test(options));
}

// ============================================================================
console.log('\n18. OCR pre-processing stays on-device and stays honest');
// ============================================================================

{
  const pre = code['lib/preprocess.js'];
  const ocr = code['lib/ocr.js'];

  // This module exists because every real input is a phone photo. It is also a
  // new place for an image to escape from, so it gets the same treatment as the
  // rest: rules 1-3 above already scan it for network calls and eval, being in
  // FIRST_PARTY. These are the ones specific to what it does.
  ok('pre-processing takes no callbacks it could leak through',
    !/onProgress|logger|postMessage/.test(pre),
    'it is pure image maths; nothing needs to escape it');
  ok('it never touches storage', !/chrome\.storage/.test(pre));
  ok('it never reads a file itself', !/FileReader|createObjectURL/.test(pre),
    'the caller decodes; this takes a canvas');

  // The decode is shared with the image tool, deliberately: EXIF orientation is
  // the most common reason a phone photo arrives sideways, and OCR on a sideways
  // card reads nothing at all.
  ok('OCR reuses the EXIF-aware decode',
    /import \{ decodeToCanvas \} from '\.\/image\.js'/.test(ocr),
    'a second decoder would be a second chance to lose the orientation tag');

  // Cleaning up must never cost the user their OCR run.
  const prepare = /export async function prepareForOcr\([\s\S]*?\n\}/.exec(ocr)?.[0] ?? '';
  ok('prepareForOcr is defined', prepare.length > 0);
  ok('a clean-up failure falls back to the original',
    /catch[\s\S]{0,400}return \{ image: file/.test(prepare),
    'an exotic format must degrade to "read it anyway", not to "read nothing"');

  // A confident wrong angle is worse than none: it resamples the image and
  // makes the reading worse with nothing to blame.
  // Checking the VALUE, not just that the name appears somewhere: the constant
  // is referenced several times, so a grep for the identifier keeps passing
  // while the bound itself is widened to something that ruins portrait cards.
  {
    const limit = Number(/MAX_SKEW_DEGREES\s*=\s*([\d.]+)/.exec(pre)?.[1]);
    ok('the skew search is bounded to a sane range', limit > 0 && limit <= 25, String(limit));
  }
  ok('too little ink means no skew', /count < 64/.test(pre));
  ok('a mostly-dark image means no skew', /ratio > 0\.9/.test(pre),
    'that is a dark background, not text');

  // Rotating onto a transparent canvas composites to black, and the engine
  // reads a black frame as ink.
  ok('rotation fills its corners with paper white',
    /function rotateCanvas[\s\S]{0,600}fillStyle = '#ffffff'/.test(pre));

  ok('the report only names what actually happened',
    /if \(applied\.scaled > 1\)[\s\S]{0,300}parts\.length \? /.test(pre),
    'an unconditional "cleaned up!" would be noise');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
