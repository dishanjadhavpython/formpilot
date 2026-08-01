// FormPilot - options page: the encrypted vault
//
// Three views, driven entirely by two questions:
//   is there a vault record in storage?  ->  no: setup, yes: locked
//   do we hold a derived key in memory?  ->  yes: unlocked
//
// The security-relevant invariants of this file:
//   * The derived key lives ONLY in the `sessionKey` variable below. It is a
//     non-extractable CryptoKey, it is never persisted, and it dies when this
//     page closes or you press Lock.
//   * The decrypted vault lives ONLY in the `vault` variable. Everything that
//     reaches chrome.storage.local goes through encryptVault() first.
//   * The passphrase itself is never stored anywhere, in any form.
//
// One deliberate exception, added in Phase 2: while unlocked we publish the
// text fields (NOT the documents, NOT the key) to chrome.storage.session so the
// popup can fill forms. Session storage is held in memory, is never written to
// disk, and is restricted to trusted extension contexts - a content script on a
// web page cannot read it. It is dropped on Lock and when Chrome closes.

import { createVault, unlockVault, encryptVault } from './lib/crypto.js';
import { DEFAULT_PRESETS, fitToBand } from './lib/image.js';
import { recognise, extractFields, terminateOcr } from './lib/ocr.js';
import { wrapBackup, validateBackup, validateVaultRecord } from './lib/backup.js';

// --- Constants --------------------------------------------------------------

const STORAGE_KEY = 'vault';          // holds the ciphertext record, nothing else
const SESSION_KEY = 'vaultData';      // in-memory copy for the popup
const MIN_PASSPHRASE = 10;
const MAX_DOC_BYTES = 2 * 1024 * 1024;   // 2 MB per image before encoding
const QUOTA_BYTES = 10 * 1024 * 1024;    // chrome.storage.local default quota

// Document types, grouped so the dropdown stays readable as it grows.
// Every <select> that offers these is built from this one source, so adding a
// type here updates the attach picker, the image tool and every document card.
const DOC_GROUPS = [
  {
    label: 'Identity',
    types: {
      photo: 'Passport photo',
      signature: 'Signature',
      pan: 'PAN card',
      aadhaar: 'Aadhaar',
      idProof: 'Other ID proof'
    }
  },
  {
    label: 'Marksheets & degrees',
    types: {
      marksheet10: '10th / SSC',
      marksheet12: '12th / HSC',
      marksheetDiploma: 'Diploma',
      marksheetDegree: 'Degree / Bachelor’s',
      marksheetMasters: 'Master’s degree',
      marksheetPhd: 'PhD'
    }
  },
  {
    label: 'Other',
    types: {
      // Kept so documents saved before the split still show a real label.
      marksheet: 'Marksheet (unspecified)',
      other: 'Other'
    }
  }
];

// Flat lookup for labelling a stored document.
const DOC_TYPES = Object.fromEntries(
  DOC_GROUPS.flatMap((group) => Object.entries(group.types))
);

/** Build a grouped type dropdown. Used by all three selects. */
function fillDocTypeSelect(select, selected) {
  select.replaceChildren();
  for (const group of DOC_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const [value, text] of Object.entries(group.types)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (value === selected) option.selected = true;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
}

// Labels for extra email addresses. Fixed rather than free text, so each one
// carries real matching synonyms (see EMAIL_LABEL_SYNONYMS in lib/match.js) —
// a free-text label could only ever be matched literally.
const EMAIL_LABELS = {
  personal: 'Personal',
  work: 'Work / Office',
  college: 'College / Institute',
  alternate: 'Alternate',
  guardian: 'Parent / Guardian',
  other: 'Other'
};

const SETTINGS_DEFAULTS = { autoLockMinutes: 5, highlightFills: true, glassMode: 'tinted', suggestFills: true };

/**
 * Tinted / Clear, applied to <html> so the liquid-glass tokens can respond.
 * The OS "reduce transparency" setting overrides both — that media query wins
 * in CSS regardless of which class is set.
 */
function applyGlassMode(mode) {
  const root = document.documentElement;
  root.classList.toggle('lg-clear', mode === 'clear');
  root.classList.toggle('lg-tinted', mode !== 'clear');
}

// --- In-memory session state (never persisted) ------------------------------

let sessionKey = null;   // CryptoKey | null  -> null means "locked"
let kdfParams = null;    // { salt, iterations } read back from the record
let vault = null;        // decrypted vault object | null
let dirty = false;       // unsaved edits?

function emptyVault() {
  return {
    version: 1,
    fields: {
      fullName: '', dob: '', email: '', phone: '',
      address: '', pan: '', aadhaarMasked: ''
    },
    emails: [],         // [{ id, label, value }]  extra addresses beyond fields.email
    customFields: [],   // [{ id, label, value }]
    documents: []       // [{ id, type, name, mime, dataUrl, bytes, addedAt }]
  };
}

// --- Tiny DOM helpers -------------------------------------------------------

const $ = (id) => document.getElementById(id);

// Each state maps to the set of sections visible in it.
const views = {
  setup: [$('setupView')],
  locked: [$('lockedView')],
  unlocked: [$('unlockedView'), $('imageView'), $('ocrView'), $('mappingsView')]
};

const statusTimers = new WeakMap();

function setStatus(el, text, kind = '', autoClearMs = 3000) {
  clearTimeout(statusTimers.get(el));
  el.textContent = text;
  el.className = `status ${kind}`.trim();
  if (text && autoClearMs) {
    statusTimers.set(el, setTimeout(() => setStatus(el, ''), autoClearMs));
  }
}

// Which field should hold focus once a view is on screen.
const VIEW_FOCUS = { setup: 'newPass', locked: 'unlockPass' };

/**
 * Run a DOM update inside a View Transition when the browser offers one, and
 * plainly when it does not. `done` fires only after the DOM has actually
 * changed — see showView for why that matters.
 */
let viewsRendered = false;   // the first paint is not a "transition"

function runViewTransition(update, done) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Skip on the very first render: there is no previous state to cross-fade
  // from, the card entrance animation is already playing, and starting a
  // transition mid-load is exactly when the UA aborts it on timeout.
  if (!viewsRendered || reducedMotion || typeof document.startViewTransition !== 'function') {
    viewsRendered = true;
    update();
    done?.();
    return;
  }

  const transition = document.startViewTransition(update);

  // `ready` and `finished` REJECT when a transition is skipped or times out —
  // routine, not exceptional. Left unhandled they surface as unhandledrejection
  // and trip the fatal-error banner, which is how this was found.
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
  transition.updateCallbackDone.then(done, done);
}

function showView(name) {
  const update = () => {
    for (const [key, sections] of Object.entries(views)) {
      for (const el of sections) el.classList.toggle('hidden', key !== name);
    }
    if (name === 'unlocked') renderMappings();
  };

  // Callers focus the passphrase box immediately after calling this. Inside a
  // view transition the class toggle happens in a callback, so that focus would
  // land on a still-hidden element and silently do nothing — re-apply it once
  // the DOM has really changed.
  runViewTransition(update, () => {
    const id = VIEW_FOCUS[name];
    if (id) $(id).focus();
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function newId() {
  return crypto.randomUUID();
}

// --- Session cache for the popup --------------------------------------------

/**
 * Publish just enough for autofill: the text fields and custom fields.
 * Documents are excluded - the popup never fills file inputs, and images would
 * bloat the in-memory cache for no benefit.
 */
async function publishSession() {
  await chrome.storage.session.set({
    [SESSION_KEY]: {
      fields: vault.fields,
      emails: vault.emails,
      customFields: vault.customFields,
      unlockedAt: Date.now()
    }
  });
  // Start the idle countdown in the service worker.
  chrome.runtime.sendMessage({ type: 'ACTIVITY' }).catch(() => {});
}

async function clearSession() {
  await chrome.storage.session.remove(SESSION_KEY);
}

// ============================================================================
// Boot
// ============================================================================

async function boot() {
  await loadSettings();

  const { [STORAGE_KEY]: record } = await chrome.storage.local.get(STORAGE_KEY);
  if (!record) {
    showView('setup');
    $('newPass').focus();
  } else {
    showView('locked');
    $('unlockPass').focus();
  }
  revealHashTarget();
}

/**
 * The popup's feature tiles open options.html#someSection. Scroll there once
 * the right view has rendered — but never steal focus from the passphrase box,
 * which is the only thing that matters while locked.
 */
function revealHashTarget() {
  const id = location.hash.slice(1);
  if (!id) return;

  const target = document.getElementById(id);
  if (!target || target.classList.contains('hidden')) return;

  requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

// ============================================================================
// Setup: create a brand-new vault
// ============================================================================

$('createBtn').addEventListener('click', async () => {
  const pass = $('newPass').value;
  const confirmPass = $('confirmPass').value;
  const status = $('setupStatus');

  if (pass.length < MIN_PASSPHRASE) {
    setStatus(status, `Use at least ${MIN_PASSPHRASE} characters.`, 'err');
    return;
  }
  if (pass !== confirmPass) {
    setStatus(status, 'The two passphrases do not match.', 'err');
    return;
  }

  $('createBtn').disabled = true;
  setStatus(status, 'Deriving key (this takes a moment by design)...', '', 0);

  try {
    // Generates a random salt, stretches the passphrase into an AES key, and
    // encrypts an empty vault so a record exists from the very first moment.
    const created = await createVault(pass, emptyVault());
    await chrome.storage.local.set({ [STORAGE_KEY]: created.record });

    sessionKey = created.key;
    kdfParams = created.kdfParams;
    vault = emptyVault();

    // Wipe the passphrase out of the DOM immediately.
    $('newPass').value = '';
    $('confirmPass').value = '';
    setStatus(status, '');

    renderVault();
    showView('unlocked');
    await publishSession();
    setStatus($('saveStatus'), 'Vault created and unlocked.', 'ok');
  } catch (err) {
    setStatus(status, `Could not create the vault: ${err.message}`, 'err', 6000);
  } finally {
    $('createBtn').disabled = false;
  }
});

// Live passphrase length feedback - deliberately not a fake "strength meter".
$('newPass').addEventListener('input', () => {
  const n = $('newPass').value.length;
  const hint = $('strengthHint');
  if (n === 0) {
    hint.textContent = 'Longer is stronger. A few random words beats one clever word.';
    hint.className = 'sub';
  } else if (n < MIN_PASSPHRASE) {
    hint.textContent = `${MIN_PASSPHRASE - n} more character${MIN_PASSPHRASE - n === 1 ? '' : 's'} needed.`;
    hint.className = 'sub warn';
  } else {
    hint.textContent = `${n} characters. Remember it - there is no reset.`;
    hint.className = 'sub';
  }
});

$('confirmPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('createBtn').click();
});

// ============================================================================
// Unlock / Lock
// ============================================================================

// --- Guessing the passphrase ------------------------------------------------
//
// PBKDF2 already makes each attempt cost about a quarter of a second, which is
// the real defence against an offline attack on the ciphertext. This is for the
// other case: someone sitting at your unlocked machine with the options page
// open, working through likely passphrases by hand or with a script.
//
// The counter lives in chrome.storage.session, so it survives a page reload
// (closing the tab is not a reset) but not a browser restart, and it can never
// lock a legitimate user out permanently - the wait tops out at half a minute.

const ATTEMPTS_KEY = 'unlockAttempts';
const FREE_ATTEMPTS = 3;          // ordinary typos should cost nothing
const BACKOFF_STEP_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;

async function readAttempts() {
  const { [ATTEMPTS_KEY]: state } = await chrome.storage.session.get(ATTEMPTS_KEY);
  return state ?? { failures: 0, blockedUntil: 0 };
}

/** Milliseconds still to wait, or 0 if an attempt is allowed right now. */
async function unlockCooldownMs() {
  const { blockedUntil } = await readAttempts();
  return Math.max(0, blockedUntil - Date.now());
}

async function recordUnlockFailure() {
  const state = await readAttempts();
  const failures = state.failures + 1;
  const over = Math.max(0, failures - FREE_ATTEMPTS);
  // 0, 0, 0, 2s, 4s, 8s, 16s, 30s, 30s...
  const wait = over === 0 ? 0 : Math.min(BACKOFF_STEP_MS * 2 ** (over - 1), MAX_BACKOFF_MS);
  await chrome.storage.session.set({
    [ATTEMPTS_KEY]: { failures, blockedUntil: Date.now() + wait }
  });
  return wait;
}

async function clearUnlockFailures() {
  await chrome.storage.session.remove(ATTEMPTS_KEY);
}

$('unlockBtn').addEventListener('click', async () => {
  const pass = $('unlockPass').value;
  const status = $('unlockStatus');

  if (!pass) {
    setStatus(status, 'Enter your passphrase.', 'err');
    return;
  }

  const cooldown = await unlockCooldownMs();
  if (cooldown > 0) {
    setStatus(status, `Too many failed attempts. Try again in ${Math.ceil(cooldown / 1000)}s.`, 'err', 5000);
    return;
  }

  $('unlockBtn').disabled = true;
  setStatus(status, 'Deriving key...', '', 0);

  try {
    const { [STORAGE_KEY]: record } = await chrome.storage.local.get(STORAGE_KEY);

    // The record on disk gets the same scrutiny as an imported file. Anything
    // that can write to extension storage could otherwise set iterations to two
    // billion and hang the tab, or drop it to 1 and quietly gut the encryption.
    const problem = validateVaultRecord(record);
    if (problem) throw new Error(problem);

    // Re-derives the key from the salt stored in the record, then tries to
    // decrypt. A failure here is how we learn the passphrase was wrong.
    const opened = await unlockVault(pass, record);
    await clearUnlockFailures();

    sessionKey = opened.key;
    kdfParams = opened.kdfParams;
    vault = { ...emptyVault(), ...opened.data };

    $('unlockPass').value = '';
    setStatus(status, '');

    renderVault();
    showView('unlocked');
    await publishSession();
    updateUsage();
    revealHashTarget();   // honour a #section the popup asked for, now it exists
  } catch (err) {
    const wait = await recordUnlockFailure();
    const suffix = wait > 0 ? ` Wait ${Math.ceil(wait / 1000)}s before trying again.` : '';
    setStatus(status, err.message + suffix, 'err', 6000);
    $('unlockPass').select();
  } finally {
    $('unlockBtn').disabled = false;
  }
});

$('unlockPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('unlockBtn').click();
});

/**
 * Tear down everything in THIS page. Deliberately does not touch
 * chrome.storage.session, so it is safe to call in response to the session
 * copy having already been cleared by the service worker's idle alarm.
 *
 * Everything below held data derived from your documents, so all of it goes -
 * "Lock" that leaves an ID card on screen is not a lock.
 */
function lockLocally() {
  // Dropping these references is the whole of "locking". The key is
  // non-extractable and unreferenced, so it is gone as far as this page is
  // concerned; the plaintext vault object becomes garbage too.
  sessionKey = null;
  kdfParams = null;
  vault = null;
  dirty = false;

  // The OCR engine holds tens of MB of WASM heap, and the text still in it came
  // off a document of yours.
  terminateOcr();
  clearOcr();

  // The image tool holds a Blob of whatever you last compressed, an object URL,
  // and a visible preview of it.
  clearResult();

  // Clear the rendered plaintext out of the DOM as well.
  for (const el of document.querySelectorAll('[data-field]')) el.value = '';
  $('emailList').replaceChildren();
  $('customList').replaceChildren();
  $('docList').replaceChildren();
  $('resultPreview').removeAttribute('src');

  // And the file pickers, which otherwise still name the document you chose.
  for (const id of ['docFile', 'imageFile', 'ocrFile']) $(id).value = '';
  $('resizeBtn').disabled = true;
  $('ocrBtn').disabled = true;

  showView('locked');
  $('unlockPass').focus();
}

/** A user-initiated lock: tear down this page AND revoke the popup's copy. */
function lock() {
  lockLocally();
  clearSession();
  chrome.runtime.sendMessage({ type: 'LOCK_NOW', reason: 'user' }).catch(() => {});
}

// The service worker clears the session copy when the idle alarm fires. This is
// how an open options page finds out and locks itself to match.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[SESSION_KEY]) return;
  const stillUnlocked = Boolean(changes[SESSION_KEY].newValue);
  if (!stillUnlocked && sessionKey) {
    lockLocally();
    setStatus($('unlockStatus'), 'Locked automatically after a period of inactivity.', 'warn', 8000);
  }
});

// --- Activity tracking ------------------------------------------------------
//
// Any interaction pushes the auto-lock deadline out, so "5 minutes" means five
// minutes of inactivity. Throttled - the alarm only needs re-arming
// occasionally, not on every keystroke.

let lastActivityPing = 0;

function reportActivity() {
  if (!sessionKey) return;                      // locked; nothing to keep alive
  const now = Date.now();
  if (now - lastActivityPing < 30_000) return;
  lastActivityPing = now;
  chrome.runtime.sendMessage({ type: 'ACTIVITY' }).catch(() => {});
}

for (const event of ['click', 'keydown', 'input']) {
  document.addEventListener(event, reportActivity, true);
}

$('lockBtn').addEventListener('click', () => {
  if (dirty && !confirm('You have unsaved changes. Lock anyway and lose them?')) return;
  lock();
});

// Escape hatch: the passphrase genuinely cannot be recovered, so the only
// option is to destroy the vault and start over.
$('resetBtn').addEventListener('click', async () => {
  const typed = prompt(
    'There is no way to recover a forgotten passphrase - the data is encrypted with it.\n\n' +
    'The only option is to delete the vault and start again. This cannot be undone.\n\n' +
    'Type DELETE to confirm:'
  );
  if (typed !== 'DELETE') return;

  await chrome.storage.local.remove(STORAGE_KEY);
  lockLocally();              // clears the key, the DOM, OCR and image state
  await clearSession();
  showView('setup');
  $('newPass').focus();
});

// ============================================================================
// Rendering the unlocked editor
// ============================================================================

function renderVault() {
  for (const input of document.querySelectorAll('[data-field]')) {
    input.value = vault.fields[input.dataset.field] ?? '';
  }
  renderEmails();
  renderCustomFields();
  renderDocuments();
  setDirty(false);
}

function setDirty(value) {
  dirty = value;
  $('saveBtn').textContent = value ? 'Save vault *' : 'Save vault';
}

// Any edit to a standard field marks the vault dirty.
// NB: `views.unlocked` is an ARRAY of sections, not an element — listen on the
// section that actually holds the fields.
$('unlockedView').addEventListener('input', (e) => {
  if (e.target.matches('[data-field]')) setDirty(true);
});

// PAN is conventionally uppercase; validate softly rather than blocking typing.
$('f-pan').addEventListener('input', () => {
  const el = $('f-pan');
  el.value = el.value.toUpperCase();
  const hint = $('panHint');
  if (!el.value) {
    hint.textContent = '10 characters: 5 letters, 4 digits, 1 letter.';
    hint.className = 'sub';
  } else if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(el.value)) {
    hint.textContent = 'Valid format.';
    hint.className = 'sub';
  } else {
    hint.textContent = 'Does not match the PAN pattern yet (ABCDE1234F).';
    hint.className = 'sub warn';
  }
});

// UIDAI guidance: never hold the full Aadhaar number if you do not need it.
// We keep the last 4 digits only, and throw the rest away before it is ever
// assigned to the vault object - so the full number never reaches storage.
function maskAadhaar(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  return `XXXX XXXX ${digits.slice(-4)}`;
}

$('f-aadhaarMasked').addEventListener('blur', () => {
  const el = $('f-aadhaarMasked');
  if (el.value.trim()) el.value = maskAadhaar(el.value);
});

// --- Extra email addresses --------------------------------------------------
//
// The primary address stays in fields.email and answers a plain "Email" field.
// These extras answer qualified ones — "Work email", "Alternate email id" —
// which is why the label is a fixed set rather than free text.

function renderEmails() {
  const list = $('emailList');
  list.replaceChildren();

  if (vault.emails.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Just the one address so far. Add a work or alternate email if forms ask for it.';
    list.append(empty);
    return;
  }

  for (const entry of vault.emails) {
    const row = document.createElement('div');
    row.className = 'custom-row custom-row--email';

    const label = document.createElement('select');
    for (const [value, text] of Object.entries(EMAIL_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (entry.label === value) option.selected = true;
      label.append(option);
    }
    label.addEventListener('change', () => { entry.label = label.value; setDirty(true); });

    const value = document.createElement('input');
    value.type = 'email';
    value.placeholder = 'name@example.com';
    value.value = entry.value;
    value.autocomplete = 'off';
    value.addEventListener('input', () => { entry.value = value.value; setDirty(true); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger tiny';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      vault.emails = vault.emails.filter((e) => e.id !== entry.id);
      renderEmails();
      setDirty(true);
    });

    row.append(label, value, remove);
    list.append(row);
  }
}

$('addEmailBtn').addEventListener('click', () => {
  // Default to the first label not already used, so two rows rarely collide.
  const used = new Set(vault.emails.map((e) => e.label));
  const next = Object.keys(EMAIL_LABELS).find((k) => !used.has(k)) ?? 'other';

  vault.emails.push({ id: newId(), label: next, value: '' });
  renderEmails();
  setDirty(true);
  $('emailList').querySelector('.custom-row:last-child input')?.focus();
});

// --- Custom fields ----------------------------------------------------------

function renderCustomFields() {
  const list = $('customList');
  list.replaceChildren();

  if (vault.customFields.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No custom fields yet. Add things like passport number, roll number, father’s name.';
    list.append(empty);
    return;
  }

  for (const field of vault.customFields) {
    const row = document.createElement('div');
    row.className = 'custom-row';

    const label = document.createElement('input');
    label.type = 'text';
    label.placeholder = 'Label (e.g. Passport no.)';
    label.value = field.label;
    label.autocomplete = 'off';
    label.addEventListener('input', () => { field.label = label.value; setDirty(true); });

    const value = document.createElement('input');
    value.type = 'text';
    value.placeholder = 'Value';
    value.value = field.value;
    value.autocomplete = 'off';
    value.addEventListener('input', () => { field.value = value.value; setDirty(true); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger tiny';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      vault.customFields = vault.customFields.filter((f) => f.id !== field.id);
      renderCustomFields();
      setDirty(true);
    });

    row.append(label, value, remove);
    list.append(row);
  }
}

$('addCustomBtn').addEventListener('click', () => {
  vault.customFields.push({ id: newId(), label: '', value: '' });
  renderCustomFields();
  setDirty(true);
  // Focus the label of the row we just added.
  $('customList').querySelector('.custom-row:last-child input')?.focus();
});

// --- Documents --------------------------------------------------------------

function renderDocuments() {
  const list = $('docList');
  list.replaceChildren();

  if (vault.documents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No documents yet. Attach a photo, signature or ID image above.';
    list.append(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'doc-grid';

  for (const doc of vault.documents) {
    const card = document.createElement('div');
    card.className = 'doc';

    // The image is a data: URL held inside the decrypted vault, so it only
    // exists in this page's memory while unlocked.
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.style.backgroundImage = `url("${doc.dataUrl}")`;
    thumb.setAttribute('role', 'img');
    thumb.setAttribute('aria-label', `${DOC_TYPES[doc.type] ?? doc.type} preview`);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('strong');
    name.textContent = doc.name;                 // textContent, never innerHTML
    const size = document.createElement('span');
    size.textContent = `${formatBytes(doc.bytes)} · ${doc.mime.replace('image/', '')}`;
    meta.append(name, size);

    const actions = document.createElement('div');
    actions.className = 'doc-actions';

    const typeSelect = document.createElement('select');
    fillDocTypeSelect(typeSelect, doc.type);
    typeSelect.style.flex = '1';
    typeSelect.addEventListener('change', () => { doc.type = typeSelect.value; setDirty(true); });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger tiny';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () => {
      if (!confirm(`Delete "${doc.name}" from the vault?`)) return;
      vault.documents = vault.documents.filter((d) => d.id !== doc.id);
      renderDocuments();
      setDirty(true);
    });

    actions.append(typeSelect, remove);
    card.append(thumb, meta, actions);
    grid.append(card);
  }

  list.append(grid);
}

$('docFile').addEventListener('change', async () => {
  const input = $('docFile');
  const file = input.files?.[0];
  const status = $('docStatus');
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    setStatus(status, 'Please choose an image file.', 'err');
    input.value = '';
    return;
  }
  if (file.size > MAX_DOC_BYTES) {
    setStatus(status,
      `${formatBytes(file.size)} is too large (limit ${formatBytes(MAX_DOC_BYTES)}). ` +
      'Use the Image tool below to compress it, then Save to vault.', 'err', 8000);
    input.value = '';
    return;
  }

  try {
    const dataUrl = await readAsDataUrl(file);
    vault.documents.push({
      id: newId(),
      type: $('docType').value,
      name: file.name,
      mime: file.type,
      dataUrl,                 // base64 - gets encrypted along with everything else
      bytes: file.size,
      addedAt: new Date().toISOString()
    });
    renderDocuments();
    setDirty(true);
    setStatus(status, `Added ${file.name}. Press Save vault to encrypt it to disk.`, 'ok', 5000);
  } catch (err) {
    setStatus(status, `Could not read that file: ${err.message}`, 'err');
  } finally {
    input.value = '';   // let the same file be picked again
  }
});

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

// ============================================================================
// Save: collect the form -> encrypt -> store
// ============================================================================

$('saveBtn').addEventListener('click', async () => {
  if (!sessionKey) return;   // defensive: cannot save while locked
  const status = $('saveStatus');

  // 1. Pull the standard fields out of the DOM into the vault object.
  for (const input of document.querySelectorAll('[data-field]')) {
    vault.fields[input.dataset.field] = input.value.trim();
  }
  // Mask Aadhaar one final time so a full number cannot slip through even if
  // the user never blurred the input.
  vault.fields.aadhaarMasked = maskAadhaar(vault.fields.aadhaarMasked);
  $('f-aadhaarMasked').value = vault.fields.aadhaarMasked;

  // 2. Drop blank custom rows rather than persisting empty noise.
  vault.customFields = vault.customFields.filter((f) => f.label.trim() || f.value.trim());
  vault.emails = vault.emails.filter((e) => e.value.trim());
  vault.updatedAt = new Date().toISOString();

  $('saveBtn').disabled = true;
  setStatus(status, 'Encrypting...', '', 0);

  try {
    // 3. Encrypt with a FRESH random IV (encryptVault generates one per call)
    //    and write only the ciphertext record.
    const record = await encryptVault(sessionKey, vault, kdfParams);
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
    await publishSession();   // keep the popup's copy in step with the edits

    renderCustomFields();
    setDirty(false);
    setStatus(status, `Saved and encrypted at ${new Date().toLocaleTimeString()}.`, 'ok', 4000);
    updateUsage();
  } catch (err) {
    const quota = /quota/i.test(err.message);
    setStatus(status,
      quota
        ? 'Out of storage. Delete a document or wait for the Phase 3 compressor.'
        : `Save failed: ${err.message}`,
      'err', 8000);
  } finally {
    $('saveBtn').disabled = false;
  }
});

async function updateUsage() {
  const used = await chrome.storage.local.getBytesInUse(STORAGE_KEY);
  const pct = Math.round((used / QUOTA_BYTES) * 100);
  $('usage').textContent =
    `Encrypted vault on disk: ${formatBytes(used)} (~${pct}% of the ${formatBytes(QUOTA_BYTES)} local quota).`;
}

// Guard against losing unsaved edits by closing the tab.
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

// ============================================================================
// Encrypted backup: export / import (Phase 5)
// ============================================================================
//
// No new cryptography here, deliberately. What sits in chrome.storage.local is
// already a self-describing encrypted envelope - KDF parameters, salt, IV and
// ciphertext. Exporting is therefore just writing that envelope to a file, and
// importing is writing it back. The backup is exactly as strong as the
// passphrase that produced it, and this code never sees either.

$('exportBtn').addEventListener('click', async () => {
  const status = $('backupStatus');

  const { [STORAGE_KEY]: record } = await chrome.storage.local.get(STORAGE_KEY);
  if (!record) {
    setStatus(status, 'There is no vault to export yet.', 'warn');
    return;
  }

  const backup = wrapBackup(record);   // ciphertext + KDF params, unchanged

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);

  const link = document.createElement('a');
  link.href = url;
  link.download = `formpilot-${stamp}.formpilot-backup`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  setStatus(status, `Exported. It is encrypted — but still keep it somewhere private.`, 'ok', 8000);
});

$('importFile').addEventListener('change', () => {
  $('importBtn').disabled = !$('importFile').files?.length;
  setStatus($('backupStatus'), '');
});

$('importBtn').addEventListener('click', async () => {
  const status = $('backupStatus');
  const file = $('importFile').files?.[0];
  if (!file) return;

  $('importBtn').disabled = true;

  try {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setStatus(status, 'That file is not valid JSON — is it really a backup?', 'err', 8000);
      return;
    }

    const problem = validateBackup(parsed);
    if (problem) {
      setStatus(status, problem, 'err', 9000);
      return;
    }

    const { [STORAGE_KEY]: existing } = await chrome.storage.local.get(STORAGE_KEY);
    const warning = existing
      ? 'This REPLACES the vault currently on this device. Anything in it that is not ' +
        'in the backup will be lost, and this cannot be undone.\n\n'
      : '';
    const stamp = parsed.exportedAt ? `Backup taken ${new Date(parsed.exportedAt).toLocaleString()}.\n\n` : '';

    if (!confirm(`${stamp}${warning}Continue?`)) return;

    await chrome.storage.local.set({ [STORAGE_KEY]: parsed.record });

    // Whatever key this page holds belongs to the OLD vault, so it must go.
    // The imported vault opens only with the passphrase it was exported under.
    lockLocally();
    await clearSession();

    $('importFile').value = '';
    showView('locked');
    setStatus($('unlockStatus'),
      'Backup restored. Unlock with the passphrase that backup was made with.', 'ok', 12000);
    setStatus(status, 'Imported.', 'ok', 6000);
  } catch (err) {
    setStatus(status, `Import failed: ${err.message}`, 'err', 9000);
  } finally {
    $('importBtn').disabled = !$('importFile').files?.length;
  }
});

// ============================================================================
// Settings (plain preferences, not secret, stored unencrypted)
// ============================================================================

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...SETTINGS_DEFAULTS, ...(settings ?? {}) };
  $('autoLock').value = merged.autoLockMinutes;
  $('highlight').checked = merged.highlightFills;
  $('suggestFills').checked = merged.suggestFills;
  $('glassMode').value = merged.glassMode;
  applyGlassMode(merged.glassMode);
}

$('glassMode').addEventListener('change', () => applyGlassMode($('glassMode').value));

$('saveSettingsBtn').addEventListener('click', async () => {
  const status = $('settingsStatus');
  const minutes = Number($('autoLock').value);

  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    setStatus(status, 'Auto-lock must be between 1 and 120 minutes.', 'err');
    return;
  }

  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: {
      ...(settings ?? {}),
      autoLockMinutes: minutes,
      highlightFills: $('highlight').checked,
      suggestFills: $('suggestFills').checked,
      glassMode: $('glassMode').value
    }
  });
  applyGlassMode($('glassMode').value);

  // Re-arm with the new timeout rather than waiting for the old one to expire.
  chrome.runtime.sendMessage({ type: 'ACTIVITY' }).catch(() => {});
  setStatus(status, `Saved. Auto-lock is now ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'ok');
});

// ============================================================================
// Last-resort error surface
// ============================================================================
//
// A thrown error inside an event handler otherwise fails silently and the page
// just appears to do nothing. Surfacing it is the difference between "broken"
// and "broken, and here is why".

function showFatal(message) {
  const banner = $('fatalError');
  banner.textContent = `Something went wrong: ${message}. Reload this page; if it persists, check the console.`;
  banner.classList.remove('hidden');
}

window.addEventListener('error', (event) => showFatal(event.message));
window.addEventListener('unhandledrejection', (event) => {
  showFatal(event.reason?.message ?? String(event.reason));
});

// ============================================================================
// Image tool (Phase 3)
// ============================================================================

const CUSTOM_ID = '__custom__';
let customPresets = [];     // user-saved specs, kept in settings (not personal)
let lastResult = null;      // the most recent output, ready to save or download
let previewUrl = null;      // object URL currently shown in the preview

function allPresets() {
  return [...DEFAULT_PRESETS, ...customPresets];
}

async function loadPresets() {
  const { settings } = await chrome.storage.local.get('settings');
  customPresets = settings?.imagePresets ?? [];

  const select = $('presetSelect');
  const previous = select.value;
  select.replaceChildren();

  for (const preset of allPresets()) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent =
      `${preset.label} - ${preset.maxWidthOrHeight}px, ${preset.minKB}-${preset.maxKB} KB`;
    select.append(option);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_ID;
  custom.textContent = 'Custom spec...';
  select.append(custom);

  if (previous) select.value = previous;
  if (!select.value) select.selectedIndex = 0;
  syncCustomVisibility();
}

function syncCustomVisibility() {
  const isCustom = $('presetSelect').value === CUSTOM_ID;
  $('customPreset').classList.toggle('hidden', !isCustom);
  $('cpNote').classList.toggle('hidden', $('cpFormat').value !== 'image/png');
}

function currentPreset() {
  const id = $('presetSelect').value;
  if (id !== CUSTOM_ID) return allPresets().find((p) => p.id === id);

  return {
    id: 'custom',
    label: 'Custom',
    format: $('cpFormat').value,
    maxWidthOrHeight: Number($('cpDim').value),
    minKB: Number($('cpMin').value),
    maxKB: Number($('cpMax').value)
  };
}

$('presetSelect').addEventListener('change', syncCustomVisibility);
$('cpFormat').addEventListener('change', syncCustomVisibility);

$('imageFile').addEventListener('change', () => {
  $('resizeBtn').disabled = !$('imageFile').files?.length;
  clearResult();
});

$('savePresetBtn').addEventListener('click', async () => {
  const preset = currentPreset();
  const status = $('imageStatus');

  if (!(preset.maxWidthOrHeight > 0) || !(preset.minKB > 0) || !(preset.maxKB > preset.minKB)) {
    setStatus(status, 'Check the spec: max edge and sizes must be positive, and min below max.', 'err', 6000);
    return;
  }

  const label = prompt('Name this preset:', `${preset.minKB}-${preset.maxKB} KB @ ${preset.maxWidthOrHeight}px`);
  if (!label) return;

  customPresets.push({ ...preset, id: `custom-${newId().slice(0, 8)}`, label });

  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({ settings: { ...(settings ?? {}), imagePresets: customPresets } });

  await loadPresets();
  $('presetSelect').value = customPresets.at(-1).id;
  syncCustomVisibility();
  setStatus(status, `Saved preset "${label}".`, 'ok');
});

function clearResult() {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  lastResult = null;
  $('resultBox').classList.add('hidden');
  $('resultActions').classList.add('hidden');
}

$('resizeBtn').addEventListener('click', async () => {
  const file = $('imageFile').files?.[0];
  const status = $('imageStatus');
  if (!file) return;

  const preset = currentPreset();
  if (!preset) { setStatus(status, 'Pick a preset first.', 'err'); return; }

  $('resizeBtn').disabled = true;
  clearResult();
  setStatus(status, 'Decoding...', '', 0);

  try {
    const result = await fitToBand(file, preset, (message) => setStatus(status, message, '', 0));

    if (result.ok) {
      lastResult = result;
      showResult(result, preset, false);
      setStatus(status,
        `Landed in band: ${formatBytes(result.bytes)} after ${result.attempts} encodes.`, 'ok', 6000);
    } else if (result.best) {
      // The band could not be hit. Show the closest attempt and say plainly
      // that it does not meet the spec, rather than passing it off as a result.
      lastResult = {
        blob: result.best.blob,
        bytes: result.best.blob.size,
        width: result.best.width,
        height: result.best.height,
        quality: result.best.quality,
        attempts: result.attempts,
        original: result.original,
        savedPercent: Math.max(0, Math.round((1 - result.best.blob.size / result.original.bytes) * 100)),
        filename: `${file.name.replace(/\.[^.]+$/, '')}-closest.jpg`,
        outOfBand: true
      };
      showResult(lastResult, preset, true);
      setStatus(status, result.message, 'err', 12000);
    } else {
      setStatus(status, result.message, 'err', 10000);
    }
  } catch (err) {
    setStatus(status, `Could not process that image: ${err.message}`, 'err', 8000);
  } finally {
    $('resizeBtn').disabled = false;
  }
});

function showResult(result, preset, outOfBand) {
  previewUrl = URL.createObjectURL(result.blob);
  $('resultPreview').src = previewUrl;

  const stats = $('resultStats');
  stats.replaceChildren();

  const rows = [
    ['Original', `${formatBytes(result.original.bytes)} · ${result.original.width}x${result.original.height}`],
    ['Result', `${formatBytes(result.bytes)} · ${result.width}x${result.height}`],
    ['Target band', `${preset.minKB}-${preset.maxKB} KB @ ${preset.maxWidthOrHeight}px`],
    ['Quality', result.quality == null ? 'n/a (PNG)' : result.quality.toFixed(2)],
    ['Encodes tried', String(result.attempts)]
  ];
  for (const [term, value] of rows) {
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = value;
    stats.append(dt, dd);
  }

  const dt = document.createElement('dt');
  dt.textContent = outOfBand ? 'Status' : 'Saved';
  const dd = document.createElement('dd');
  if (outOfBand) {
    dd.textContent = 'Outside the required band';
    dd.style.color = 'var(--danger)';
    dd.style.fontWeight = '700';
  } else {
    dd.className = 'saved-badge';
    dd.textContent = `${result.savedPercent}% smaller`;
  }
  stats.append(dt, dd);

  $('resultBar').style.width = `${Math.min(100, result.savedPercent)}%`;
  $('resultBar').style.background = outOfBand ? 'var(--danger)' : 'var(--brand)';

  $('resultBox').classList.remove('hidden');
  $('resultActions').classList.remove('hidden');
}

$('downloadBtn').addEventListener('click', () => {
  if (!lastResult) return;
  // A programmatic click on an <a download> - note this is a download, not a
  // form submission, so it does not run afoul of the never-auto-submit rule.
  const url = URL.createObjectURL(lastResult.blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = lastResult.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('saveToVaultBtn').addEventListener('click', async () => {
  if (!lastResult || !vault) return;
  const status = $('imageStatus');

  if (lastResult.outOfBand &&
      !confirm('This file is outside the required size band and the portal may reject it. Save it anyway?')) {
    return;
  }

  const dataUrl = await blobToDataUrl(lastResult.blob);
  vault.documents.push({
    id: newId(),
    type: $('resultDocType').value,
    name: lastResult.filename,
    mime: lastResult.blob.type || 'image/jpeg',
    dataUrl,
    bytes: lastResult.blob.size,
    addedAt: new Date().toISOString()
  });

  renderDocuments();
  setDirty(true);
  setStatus(status, 'Added to the vault. Press "Save vault" to encrypt it to disk.', 'ok', 6000);
});

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

// ============================================================================
// OCR (Phase 4)
// ============================================================================

// Human-readable names for the field keys the heuristics can produce.
const OCR_FIELD_LABELS = {
  fullName: 'Full name',
  dob: 'Date of birth',
  pan: 'PAN',
  aadhaarMasked: 'Aadhaar (masked)'
};

// tesseract.js reports several phases; only some carry a useful percentage.
const OCR_PHASES = {
  'loading tesseract core': 'Loading OCR engine',
  'initializing tesseract': 'Starting engine',
  'loading language traineddata': 'Loading English data',
  'initializing api': 'Preparing',
  'recognizing text': 'Reading text'
};

let ocrSuggestions = [];

$('ocrFile').addEventListener('change', () => {
  $('ocrBtn').disabled = !$('ocrFile').files?.length;
  clearOcr();
});

function clearOcr() {
  ocrSuggestions = [];
  $('ocrResult')?.classList.add('hidden');
  $('ocrBarWrap')?.classList.add('hidden');
  $('ocrFields')?.replaceChildren();

  // The recognised text and confidence came off one of your documents - hiding
  // the panel is not enough, the content has to go too.
  const raw = $('ocrRaw');
  if (raw) raw.textContent = '';
  const confidence = $('ocrConfidence');
  if (confidence) confidence.replaceChildren();
}

$('ocrBtn').addEventListener('click', async () => {
  const file = $('ocrFile').files?.[0];
  const status = $('ocrStatus');
  if (!file) return;

  $('ocrBtn').disabled = true;
  clearOcr();
  $('ocrBarWrap').classList.remove('hidden');
  setStatus(status, 'Starting the OCR engine...', '', 0);

  try {
    const result = await recognise(file, (message) => {
      const phase = OCR_PHASES[message.status] ?? message.status;
      const percent = Math.round((message.progress ?? 0) * 100);
      $('ocrBar').style.width = `${percent}%`;
      setStatus(status, `${phase}... ${percent}%`, '', 0);
    });

    $('ocrBar').style.width = '100%';
    ocrSuggestions = extractFields(result);
    renderOcrResult(result);

    if (ocrSuggestions.length === 0) {
      setStatus(status,
        'Text was read, but nothing matched a known field pattern. Check the raw text below.', 'warn', 9000);
    } else {
      setStatus(status, `Found ${ocrSuggestions.length} candidate field(s). Review before applying.`, 'ok', 8000);
    }
  } catch (err) {
    setStatus(status, `OCR failed: ${err.message}`, 'err', 12000);
    $('ocrBarWrap').classList.add('hidden');
  } finally {
    $('ocrBtn').disabled = false;
  }
});

function renderOcrResult(result) {
  // Overall confidence, stated plainly rather than dressed up.
  const confidence = Math.round(result.confidence);
  const el = $('ocrConfidence');
  el.replaceChildren();

  const score = document.createElement('span');
  score.className = `conf ${confidence >= 80 ? 'high' : confidence >= 60 ? 'low' : 'bad'}`;
  score.textContent = `${confidence}%`;

  const caption = document.createElement('span');
  caption.textContent = confidence >= 80
    ? ' — good. Still check every value.'
    : confidence >= 60
      ? ' — mediocre. Expect misreads; a sharper, straighter photo helps.'
      : ' — poor. Treat every suggestion as a guess.';

  el.append(score, caption);

  $('ocrRaw').textContent = result.text.trim() || '(nothing recognised)';

  const list = $('ocrFields');
  list.replaceChildren();

  if (ocrSuggestions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No recognisable PAN, date, Aadhaar or name line found.';
    list.append(empty);
    return;
  }

  for (const suggestion of ocrSuggestions) {
    const row = document.createElement('div');
    row.className = 'ocr-row';

    const tick = document.createElement('input');
    tick.type = 'checkbox';
    tick.checked = true;
    tick.id = `ocr-${suggestion.key}`;
    suggestion.checkbox = tick;

    const name = document.createElement('label');
    name.className = 'name';
    name.htmlFor = tick.id;
    name.textContent = OCR_FIELD_LABELS[suggestion.key] ?? suggestion.key;
    name.style.margin = '0';

    // Editable, because "let me edit every field before saving" is the point.
    const input = document.createElement('input');
    input.type = 'text';
    input.value = suggestion.value;
    input.autocomplete = 'off';
    input.addEventListener('input', () => { suggestion.value = input.value; });

    row.append(tick, name, input);
    list.append(row);

    if (suggestion.note) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = suggestion.note;
      row.append(note);
    }
  }
}

$('ocrApplyBtn').addEventListener('click', () => {
  const status = $('ocrStatus');
  let applied = 0;

  for (const suggestion of ocrSuggestions) {
    if (!suggestion.checkbox?.checked) continue;

    // Write into the visible form, not straight into the vault: the user still
    // reviews the whole record and presses "Save vault" to encrypt it.
    const field = document.querySelector(`[data-field="${suggestion.key}"]`);
    if (!field) continue;

    field.value = suggestion.key === 'aadhaarMasked' ? maskAadhaar(suggestion.value) : suggestion.value;
    applied++;
  }

  if (applied === 0) {
    setStatus(status, 'Nothing ticked.', 'warn');
    return;
  }

  setDirty(true);
  setStatus(status, `Applied ${applied} field(s) to the form above. Press "Save vault" to encrypt them.`, 'ok', 9000);
  $('unlockedView').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('ocrDiscardBtn').addEventListener('click', () => {
  clearOcr();
  $('ocrFile').value = '';
  $('ocrBtn').disabled = true;
  setStatus($('ocrStatus'), 'Discarded.', '', 2500);
});

// ============================================================================
// Taught site mappings (reviewing and deleting what Phase 2 learned)
// ============================================================================

async function renderMappings() {
  const list = $('mappingsList');
  const { siteMappings = {} } = await chrome.storage.local.get('siteMappings');
  const hosts = Object.keys(siteMappings).sort();

  list.replaceChildren();

  if (hosts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing taught yet. Use "Teach fields on this site" in the popup when a form fills wrongly.';
    list.append(empty);
    return;
  }

  for (const host of hosts) {
    const entries = Object.entries(siteMappings[host]);

    const heading = document.createElement('h3');
    heading.textContent = host;
    heading.style.marginBottom = '6px';

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'danger tiny';
    forget.textContent = 'Forget site';
    forget.style.marginLeft = '10px';
    forget.addEventListener('click', async () => {
      if (!confirm(`Forget all ${entries.length} mapping(s) for ${host}?`)) return;
      const { siteMappings: current = {} } = await chrome.storage.local.get('siteMappings');
      delete current[host];
      await chrome.storage.local.set({ siteMappings: current });
      renderMappings();
    });
    heading.append(forget);

    const table = document.createElement('table');
    table.className = 'maps';
    const head = document.createElement('tr');
    for (const label of ['Field', 'Selector', '']) {
      const th = document.createElement('th');
      th.textContent = label;
      head.append(th);
    }
    table.append(head);

    for (const [selector, key] of entries) {
      const row = document.createElement('tr');

      const fieldCell = document.createElement('td');
      fieldCell.textContent = key.startsWith('custom:') ? key.slice(7) : key;

      const selectorCell = document.createElement('td');
      const code = document.createElement('code');
      code.textContent = selector;
      selectorCell.append(code);

      const actionCell = document.createElement('td');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger tiny';
      remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        const { siteMappings: current = {} } = await chrome.storage.local.get('siteMappings');
        delete current[host]?.[selector];
        if (current[host] && Object.keys(current[host]).length === 0) delete current[host];
        await chrome.storage.local.set({ siteMappings: current });
        renderMappings();
      });
      actionCell.append(remove);

      row.append(fieldCell, selectorCell, actionCell);
      table.append(row);
    }
    list.append(heading, table);
  }
}

fillDocTypeSelect($('docType'), 'photo');
fillDocTypeSelect($('resultDocType'), 'photo');
loadPresets();
boot();
