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

// --- Constants --------------------------------------------------------------

const STORAGE_KEY = 'vault';          // holds the ciphertext record, nothing else
const SESSION_KEY = 'vaultData';      // in-memory copy for the popup
const MIN_PASSPHRASE = 10;
const MAX_DOC_BYTES = 2 * 1024 * 1024;   // 2 MB per image before encoding
const QUOTA_BYTES = 10 * 1024 * 1024;    // chrome.storage.local default quota

const DOC_TYPES = {
  photo: 'Passport photo',
  signature: 'Signature',
  pan: 'PAN card',
  aadhaar: 'Aadhaar',
  marksheet: 'Marksheet',
  idProof: 'Other ID proof',
  other: 'Other'
};

const SETTINGS_DEFAULTS = { autoLockMinutes: 5, highlightFills: true };

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
    customFields: [],   // [{ id, label, value }]
    documents: []       // [{ id, type, name, mime, dataUrl, bytes, addedAt }]
  };
}

// --- Tiny DOM helpers -------------------------------------------------------

const $ = (id) => document.getElementById(id);

const views = {
  setup: $('setupView'),
  locked: $('lockedView'),
  unlocked: $('unlockedView')
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

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle('hidden', key !== name);
  }
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
      customFields: vault.customFields,
      unlockedAt: Date.now()
    }
  });
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

$('unlockBtn').addEventListener('click', async () => {
  const pass = $('unlockPass').value;
  const status = $('unlockStatus');

  if (!pass) {
    setStatus(status, 'Enter your passphrase.', 'err');
    return;
  }

  $('unlockBtn').disabled = true;
  setStatus(status, 'Deriving key...', '', 0);

  try {
    const { [STORAGE_KEY]: record } = await chrome.storage.local.get(STORAGE_KEY);

    // Re-derives the key from the salt stored in the record, then tries to
    // decrypt. A failure here is how we learn the passphrase was wrong.
    const opened = await unlockVault(pass, record);

    sessionKey = opened.key;
    kdfParams = opened.kdfParams;
    vault = { ...emptyVault(), ...opened.data };

    $('unlockPass').value = '';
    setStatus(status, '');

    renderVault();
    showView('unlocked');
    await publishSession();
    updateUsage();
  } catch (err) {
    setStatus(status, err.message, 'err', 5000);
    $('unlockPass').select();
  } finally {
    $('unlockBtn').disabled = false;
  }
});

$('unlockPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('unlockBtn').click();
});

function lock() {
  // Dropping these references is the whole of "locking". The key is
  // non-extractable and unreferenced, so it is gone as far as this page is
  // concerned; the plaintext vault object becomes garbage too.
  sessionKey = null;
  kdfParams = null;
  vault = null;
  dirty = false;

  // Revoke the popup's copy too, or "Lock" would be a lie.
  clearSession();

  // Clear the rendered plaintext out of the DOM as well.
  for (const el of document.querySelectorAll('[data-field]')) el.value = '';
  $('customList').replaceChildren();
  $('docList').replaceChildren();

  showView('locked');
  $('unlockPass').focus();
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
  await clearSession();
  sessionKey = null; kdfParams = null; vault = null; dirty = false;
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
  renderCustomFields();
  renderDocuments();
  setDirty(false);
}

function setDirty(value) {
  dirty = value;
  $('saveBtn').textContent = value ? 'Save vault *' : 'Save vault';
}

// Any edit to a standard field marks the vault dirty.
views.unlocked.addEventListener('input', (e) => {
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
    for (const [value, text] of Object.entries(DOC_TYPES)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      if (doc.type === value) option.selected = true;
      typeSelect.append(option);
    }
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
      'Phase 3 adds a compressor for exactly this.', 'err', 7000);
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
// Settings (plain preferences, not secret, stored unencrypted)
// ============================================================================

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...SETTINGS_DEFAULTS, ...(settings ?? {}) };
  $('autoLock').value = merged.autoLockMinutes;
  $('highlight').checked = merged.highlightFills;
}

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
      highlightFills: $('highlight').checked
    }
  });
  setStatus(status, 'Saved.', 'ok');
});

boot();
