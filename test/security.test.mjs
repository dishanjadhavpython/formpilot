// FormPilot - security behaviour.
//
//   node test/security.test.mjs
//
// audit.test.mjs greps the source for things that must not be there. This suite
// runs the code and checks it actually behaves safely, on the two questions
// that decide whether this extension is trustworthy:
//
//   1. What crosses into a web page, and when?
//   2. What does the extension believe when it is handed a hostile file?

import fs from 'node:fs';
import vm from 'node:vm';
import { createVault, deriveKey, randomBytes, bytesToBase64 } from '../lib/crypto.js';
import { validateBackup, validateVaultRecord, wrapBackup } from '../lib/backup.js';

vm.runInThisContext(fs.readFileSync(new URL('../lib/match.js', import.meta.url), 'utf8'));
const M = globalThis.FormPilotMatch;

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// A vault where every value is a distinctive, greppable string, so "did this
// leak?" is a substring search rather than a judgement call.
const FIELDS = {
  fullName: 'Dishan Jadhav',
  dob: '1999-04-17',
  email: 'dishan.primary@example.com',
  phone: '9876543210',
  address: '221B Baker Street, Mumbai 400001',
  pan: 'ABCDE1234F',
  aadhaarMasked: 'XXXX XXXX 9012'
};
const EMAILS = [
  { label: 'work', value: 'dishan.work@example.com' },
  { label: 'college', value: 'dishan.college@example.edu' }
];
const CUSTOM = [
  { id: '1', label: 'Employee ID', value: 'EMP-99182' },
  { id: '2', label: 'Passport no.', value: 'Z1234567' }
];

// A distinctive fake "image" body per document, so "did the bytes leak?" is
// the same substring search the text fields already get.
const DOCUMENTS = [
  { type: 'aadhaar',   name: 'aadhaar.jpg',   mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AADHAARBYTES==' },
  { type: 'pan',       name: 'pan.jpg',       mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,PANCARDBYTES==' },
  { type: 'signature', name: 'sig.png',       mime: 'image/png',  dataUrl: 'data:image/png;base64,SIGNATUREBYTES==' }
];

const SECRETS = [
  ...Object.values(FIELDS),
  ...EMAILS.map((e) => e.value),
  ...CUSTOM.map((c) => c.value),
  'Dishan', 'Jadhav', '9876543210', 'ABCDE1234F', '9012', 'Baker Street',
  'AADHAARBYTES', 'PANCARDBYTES', 'SIGNATUREBYTES'
];

// ============================================================================
console.log('\n1. Detection metadata carries no personal data at all');
// ============================================================================
//
// This is the one that matters most. The DETECT payload is sent into EVERY
// http(s) page opened while the vault is unlocked - news sites, forums,
// anything. If a value is in here, browsing the web broadcasts it.

const meta = M.describeVault(FIELDS, CUSTOM, EMAILS);
const wire = JSON.stringify(meta);

for (const secret of SECRETS) {
  ok(`no "${secret.slice(0, 24)}"`, !wire.includes(secret));
}
ok('the payload is small', wire.length < 800, `${wire.length} bytes`);

console.log('\n   ...but it still says what CAN be answered');
ok('knows it has an email', meta.keys.includes('email'));
ok('knows it has a work email', meta.keys.includes('email:work'));
ok('knows it has a PAN', meta.keys.includes('pan'));
ok('knows about custom fields', meta.keys.includes('custom:Employee ID'));
ok('derived keys are included', meta.keys.includes('firstName') && meta.keys.includes('lastName'),
  'fullName also answers first/last name, so detection must count those too');

console.log('\n   ...and labels come through, because matching needs them');
ok('email labels survive', meta.emails.some((e) => e.label === 'work'));
ok('custom labels survive', meta.customFields.some((c) => c.label === 'Employee ID'));
ok('email VALUES do not', meta.emails.every((e) => e.value === undefined));
ok('custom VALUES do not', meta.customFields.every((c) => c.value === undefined));

// ============================================================================
console.log('\n1b. Document detection metadata carries no image data either');
// ============================================================================
//
// The same DETECT payload also carries docKeys/docMimes now (Phase 6). A mime
// type is metadata, same category as an email label - the actual image must
// never be in here.

const docMeta = M.describeDocs(DOCUMENTS);
const docWire = JSON.stringify(docMeta);

for (const secret of SECRETS) {
  ok(`docs: no "${secret.slice(0, 24)}"`, !docWire.includes(secret));
}
ok('docs: says what CAN be answered', ['aadhaar', 'pan', 'signature'].every((t) => docMeta.docKeys.includes(t)));
ok('docs: mime survives, per type', docMeta.docMimes.aadhaar === 'image/jpeg' && docMeta.docMimes.signature === 'image/png');

// ============================================================================
console.log('\n2. Detection and filling agree on what is fillable');
// ============================================================================
//
// planFill() counts a field only when its key is in this key list. If the list
// and the real value map ever diverge, a suggestion promises a number the fill
// cannot deliver - or worse, a fill silently skips a field it claimed.

const values = M.expandValues(FIELDS, CUSTOM, EMAILS);
const keysFromValues = Object.keys(values).sort();
ok('key sets match exactly', JSON.stringify(meta.keys.slice().sort()) === JSON.stringify(keysFromValues),
  `meta ${meta.keys.length} vs values ${keysFromValues.length}`);
ok('every advertised key has a real value', meta.keys.every((k) => values[k] !== undefined && values[k] !== ''));

// Empty fields must not be advertised: a field with no value would be counted
// as fillable and then skipped.
const sparse = M.describeVault({ fullName: 'Solo', email: '' }, [], []);
ok('empty values are not advertised', !sparse.keys.includes('email'), sparse.keys.join(','));

// ============================================================================
console.log('\n3. A fill hands over only the values it is about to type');
// ============================================================================

const narrowed = M.pickValues(values, ['email', 'phone']);
ok('returns exactly the asked-for keys', JSON.stringify(Object.keys(narrowed).sort()) === '["email","phone"]');
ok('the values are right', narrowed.email === FIELDS.email && narrowed.phone === FIELDS.phone);

const leaked = JSON.stringify(narrowed);
ok('a name-only form never sees the PAN', !leaked.includes('ABCDE1234F'));
ok('...nor the address', !leaked.includes('Baker Street'));
ok('...nor the other email addresses', !leaked.includes('dishan.work@example.com'));

ok('unknown keys are ignored', Object.keys(M.pickValues(values, ['nonsense', '__proto__'])).length === 0,
  'a page asking for a key we do not have gets nothing, not undefined');
ok('an empty request yields nothing', Object.keys(M.pickValues(values, [])).length === 0);

console.log('\n   ...and the same is true of documents');
const narrowedDocs = M.pickDocs(DOCUMENTS, ['pan']);
ok('returns exactly the asked-for type', JSON.stringify(Object.keys(narrowedDocs)) === '["pan"]');
const leakedDocs = JSON.stringify(narrowedDocs);
ok('a signature-only request never sees the Aadhaar image', !leakedDocs.includes('AADHAARBYTES'));
ok('...nor the signature', !leakedDocs.includes('SIGNATUREBYTES'));
ok('an empty doc-type request yields nothing', Object.keys(M.pickDocs(DOCUMENTS, [])).length === 0);

// ============================================================================
console.log('\n4. Fields belonging to other people are still refused');
// ============================================================================

const dict = M.buildDictionary(CUSTOM, EMAILS);
const infer = (text) => M.inferKey(M.normalise(text), dict)?.key ?? null;

for (const [label, why] of [
  ['Password', 'never, under any circumstances'],
  ['Confirm Password', 'never'],
  ['Username', 'contains "name"'],
  ['OTP', 'must be typed by a human'],
  ['Captcha', 'must be typed by a human'],
  ['Verification Code', 'must be typed by a human'],
  ["Father's Name", 'somebody else'],
  ['Spouse Email', 'somebody else'],
  ['Nominee Name', 'somebody else'],
  ['Emergency Contact Number', 'somebody else'],
  ['Company Name', 'not the user']
]) {
  ok(`refuses "${label}"`, infer(label) === null, why);
}

// A value explicitly labelled for that person is still allowed through - the
// guard is about guessing, not about a blanket ban.
ok('but "Parent Email" works when labelled',
  M.inferKey(M.normalise('Parent Email'), M.buildDictionary([], [{ label: 'guardian', value: 'p@example.com' }]))?.key
    === 'email:guardian');

// ============================================================================
console.log('\n5. A hostile backup file cannot weaken or hang the vault');
// ============================================================================

const { record } = await createVault('a passphrase that is long', { fields: FIELDS });
const good = wrapBackup(record);
const withRecord = (changes) => ({ ...good, record: { ...record, ...changes } });
const withKdf = (changes) => withRecord({ kdf: { ...record.kdf, ...changes } });

ok('a genuine backup validates', validateBackup(good) === null, String(validateBackup(good)));

const rejects = (label, parsed, why) => {
  const problem = validateBackup(parsed);
  ok(label, typeof problem === 'string', typeof problem === 'string' ? why : 'ACCEPTED — ' + why);
};

rejects('iterations: 1', withKdf({ iterations: 1 }),
  'would restore a vault with effectively no key stretching');
rejects('iterations: 149,999', withKdf({ iterations: 149_999 }), 'below the documented floor');
rejects('iterations: 2 billion', withKdf({ iterations: 2_000_000_000 }),
  'would freeze the browser on every unlock');
rejects('iterations: 1e21', withKdf({ iterations: 1e21 }), 'not an integer either');
rejects('iterations: -5', withKdf({ iterations: -5 }), 'negative');
rejects('a different KDF', withKdf({ name: 'scrypt' }), 'we do not implement it');
rejects('a weaker hash', withKdf({ hash: 'SHA-1' }), 'downgrade attempt');
rejects('a truncated IV', withRecord({ iv: bytesToBase64(randomBytes(8)) }),
  'GCM is defined around a 96-bit IV');
rejects('an oversized IV', withRecord({ iv: bytesToBase64(randomBytes(32)) }), 'not our format');
rejects('a short salt', withKdf({ salt: bytesToBase64(randomBytes(4)) }), 'weakens the salt');
rejects('non-base64 ciphertext', withRecord({ ciphertext: 'not base64 at all!!' }),
  'would throw deep inside atob() at unlock time');
rejects('ciphertext of one byte', withRecord({ ciphertext: bytesToBase64(randomBytes(1)) }),
  'too short even for the GCM tag');
rejects('a 20 MB ciphertext', withRecord({ ciphertext: 'A'.repeat(28 * 1024 * 1024) }),
  'would fill the ~10 MB storage quota and wedge saving');

ok('iterations at the floor are accepted', validateBackup(withKdf({ iterations: 150_000 })) === null);
ok('310,000 is accepted', validateBackup(withKdf({ iterations: 310_000 })) === null);

// ============================================================================
console.log('\n6. The record already in storage gets the same scrutiny');
// ============================================================================
//
// The file on disk is not more trustworthy than the file on the USB stick - it
// just arrived earlier. Anything able to write extension storage could set
// iterations to two billion and hang the tab on every unlock.

ok('a genuine record validates', validateVaultRecord(record) === null, String(validateVaultRecord(record)));
ok('a tampered iteration count is caught',
  typeof validateVaultRecord({ ...record, kdf: { ...record.kdf, iterations: 1 } }) === 'string');
ok('a missing record is caught', typeof validateVaultRecord(undefined) === 'string');
ok('a swapped algorithm is caught',
  typeof validateVaultRecord({ ...record, kdf: { ...record.kdf, name: 'PBKDF1' } }) === 'string');

// ============================================================================
console.log('\n7. The derived key cannot be read back out');
// ============================================================================

const key = await deriveKey('a passphrase that is long', randomBytes(16), 150_000);
ok('extractable is false', key.extractable === false);
let exported = null;
try { exported = await crypto.subtle.exportKey('raw', key); } catch { /* expected */ }
ok('exportKey refuses', exported === null,
  'so the key cannot be logged, stored or put in a message');
ok('usages are only encrypt/decrypt',
  JSON.stringify(key.usages.slice().sort()) === '["decrypt","encrypt"]');

// ============================================================================
console.log('\n8. The service worker only releases values to a real page, on request');
// ============================================================================
//
// background.js is a classic script full of chrome.* calls, so it is run here
// against a stub that captures the message listener - the same listener Chrome
// would install - and then messaged directly.

const storage = { local: { settings: { suggestFills: true, highlightFills: true } }, session: {} };
const area = (backing) => ({
  get: async (keys) => (typeof keys === 'string'
    ? { [keys]: backing[keys] }
    : Object.fromEntries([].concat(keys).map((k) => [k, backing[k]]))),
  set: async (items) => { Object.assign(backing, items); },
  remove: async (keys) => { for (const k of [].concat(keys)) delete backing[k]; },
  setAccessLevel: async () => {}
});

let onMessage = null;
const listener = { addListener: (fn) => { onMessage = fn; } };
globalThis.chrome = {
  runtime: {
    id: 'formpilotformpilotformpilotform',
    getURL: (p) => `chrome-extension://formpilotformpilotformpilotform/${p}`,
    getManifest: () => ({ version: '0.1.0' }),
    onMessage: listener, onInstalled: listener, onStartup: listener
  },
  storage: { local: area(storage.local), session: area(storage.session), onChanged: listener },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: listener },
  tabs: { onUpdated: listener, onActivated: listener, sendMessage: async () => ({}), get: async () => ({}) },
  scripting: { executeScript: async () => [] },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
};

vm.runInThisContext(fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8'));
ok('the worker installed a message listener', typeof onMessage === 'function');

const ask = (message, sender) => new Promise((resolve) => {
  onMessage(message, sender, resolve);
});

const PAGE = { id: chrome.runtime.id, tab: { id: 7, url: 'https://forms.example.com/apply' } };
const POPUP = { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') };
// options_ui.open_in_tab is true, so options.html runs as the content of a real
// tab - Chrome populates sender.tab for it exactly like it would for a content
// script. Anything that tells "an extension page" apart from "a page" using
// sender.tab alone will misjudge this sender.
const OPTIONS_TAB = {
  id: chrome.runtime.id,
  tab: { id: 9, url: chrome.runtime.getURL('options.html') },
  url: chrome.runtime.getURL('options.html')
};
const OTHER_EXTENSION = { id: 'someotherextensionsomeotherexten' };

// Locked: nothing is released, whoever asks.
ok('a locked vault releases nothing',
  (await ask({ type: 'REQUEST_FILL', keys: ['email'] }, PAGE)).ok === false);

storage.session.vaultData = { fields: FIELDS, emails: EMAILS, customFields: CUSTOM, documents: DOCUMENTS };

const released = await ask({ type: 'REQUEST_FILL', keys: ['email', 'phone'] }, PAGE);
ok('an unlocked vault releases the asked-for keys', released.ok === true);
ok('exactly those keys, no more',
  JSON.stringify(Object.keys(released.values ?? {}).sort()) === '["email","phone"]',
  Object.keys(released.values ?? {}).join(','));
ok('the values are correct', released.values.email === FIELDS.email);

const overreach = await ask({ type: 'REQUEST_FILL', keys: ['email', 'pan', 'address', 'nope'] }, PAGE);
ok('unknown keys are dropped, not undefined',
  !Object.hasOwn(overreach.values, 'nope'), Object.keys(overreach.values).join(','));

const flood = await ask({ type: 'REQUEST_FILL', keys: Array(500).fill('email') }, PAGE);
ok('a flood of keys is capped', Object.keys(flood.values).length <= 60);

// Same authorization path, same scoping - for documents.
const releasedDocs = await ask({ type: 'REQUEST_FILL', keys: [], docTypes: ['signature'] }, PAGE);
ok('an unlocked vault releases the asked-for document type', releasedDocs.ok === true);
ok('exactly that type, no more',
  JSON.stringify(Object.keys(releasedDocs.docs ?? {})) === '["signature"]',
  Object.keys(releasedDocs.docs ?? {}).join(','));
ok('the document bytes are correct', releasedDocs.docs.signature.dataUrl === DOCUMENTS[2].dataUrl);
ok('a signature-only request never carries the Aadhaar image',
  !JSON.stringify(releasedDocs.docs).includes('AADHAARBYTES'));

const overreachDocs = await ask({ type: 'REQUEST_FILL', keys: [], docTypes: ['pan', 'notAType'] }, PAGE);
ok('unknown document types are dropped, not undefined',
  !Object.hasOwn(overreachDocs.docs, 'notAType'), Object.keys(overreachDocs.docs).join(','));

const floodDocs = await ask({ type: 'REQUEST_FILL', keys: [], docTypes: Array(500).fill('pan') }, PAGE);
ok('a flood of document types is capped', Object.keys(floodDocs.docs).length <= 20);

const lockedDocRequest = await (async () => {
  const saved = storage.session.vaultData;
  delete storage.session.vaultData;
  const reply = await ask({ type: 'REQUEST_FILL', keys: [], docTypes: ['pan'] }, PAGE);
  storage.session.vaultData = saved;
  return reply;
})();
ok('a locked vault releases no documents either', lockedDocRequest.ok === false);

// Where the request comes from decides whether it is answered at all.
ok('another extension is refused outright',
  (await ask({ type: 'REQUEST_FILL', keys: ['email'] }, OTHER_EXTENSION)).ok === false);
ok('a chrome:// page is refused',
  (await ask({ type: 'REQUEST_FILL', keys: ['email'] },
    { id: chrome.runtime.id, tab: { id: 8, url: 'chrome://settings' } })).ok === false);
ok('a sender with no tab is refused',
  (await ask({ type: 'REQUEST_FILL', keys: ['email'] }, POPUP)).ok === false,
  'the popup has direct session access and never needs this path');

// Deferring auto-lock is a privileged-page job: a page that could send ACTIVITY
// would keep the vault unlocked for as long as it stayed open.
ok('ACTIVITY from an extension page is accepted', (await ask({ type: 'ACTIVITY' }, POPUP)).ok === true);
ok('ACTIVITY from the options page (open_in_tab: true, so it has a real tab) is accepted',
  (await ask({ type: 'ACTIVITY' }, OPTIONS_TAB)).ok === true,
  'options.js pings ACTIVITY on every click/keydown/input - if this is refused, the vault ' +
  'force-locks on a flat timer no matter how actively it is being used');
ok('ACTIVITY from a web page is refused', (await ask({ type: 'ACTIVITY' }, PAGE)).ok === false,
  'otherwise a page could hold the vault unlocked indefinitely');
ok('ACTIVITY from another extension is refused',
  (await ask({ type: 'ACTIVITY' }, OTHER_EXTENSION)).ok === false);

// Locking early can only reduce exposure, so anyone inside the extension may.
ok('LOCK_NOW is accepted from a page', (await ask({ type: 'LOCK_NOW' }, PAGE)).ok === true);
ok('...and it really locks', storage.session.vaultData === undefined);

// Turning suggestions off must stop the release path too, not just the chip.
storage.session.vaultData = { fields: FIELDS, emails: EMAILS, customFields: CUSTOM };
storage.local.settings = { ...storage.local.settings, suggestFills: false };
ok('suggestions off blocks the release path',
  (await ask({ type: 'REQUEST_FILL', keys: ['email'] }, PAGE)).ok === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
