// FormPilot - background service worker (Manifest V3)
//
// Important MV3 detail: this worker is EPHEMERAL. Chrome starts it when an event
// fires and shuts it down when it goes idle, which wipes every global variable.
// So never keep real state in a variable up here - put it in chrome.storage.
// (In Phase 1 the decrypted vault key is the one exception: it lives only in the
// page that unlocked it, in memory, and is never persisted.)

// --- Session storage access -------------------------------------------------
//
// While the vault is unlocked, the options page publishes the decrypted text
// fields to chrome.storage.session so the popup can fill forms. That store is
// memory-only (never written to disk), but by default we must also make sure a
// content script running inside a web page cannot read it. TRUSTED_CONTEXTS is
// already the default; setting it explicitly means a future change to the
// default cannot silently expose the vault.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch((err) => console.warn('[FormPilot] could not set session access level:', err));

// --- Lifecycle ------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[FormPilot] onInstalled:', details.reason);

  // Seed a tiny settings object on first install so later phases can rely on it.
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({
      settings: {
        installedAt: new Date().toISOString(),
        autoLockMinutes: 5,   // used in Phase 5 (idle auto-lock)
        highlightFills: true  // used in Phase 2 (outline filled fields)
      }
    });
    console.log('[FormPilot] default settings written');
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[FormPilot] browser started, service worker awake');
  // Session storage should already be empty after a browser restart. Clearing
  // it anyway costs nothing and means a new session always starts locked.
  await chrome.storage.session.remove('vaultData');
});

// --- Messaging ------------------------------------------------------------
//
// The popup, the options page and (later) the content script all run in separate
// contexts and cannot call each other's functions directly. They talk through
// chrome.runtime.sendMessage / chrome.tabs.sendMessage. This is the single entry
// point for messages aimed at the service worker.

// --- Idle auto-lock ---------------------------------------------------------
//
// The vault has to lock itself even when every extension page is closed, so the
// countdown cannot live in a page. It also cannot live in a variable here - the
// service worker sleeps and forgets. chrome.alarms survives both: it is
// persisted by the browser and wakes the worker when it fires.
//
// The alarm is (re)armed on unlock and on any sign of activity, so "N minutes"
// means N minutes of inactivity rather than N minutes since unlocking.

const AUTO_LOCK_ALARM = 'auto-lock';
const SESSION_KEY = 'vaultData';

async function armAutoLock() {
  const { [SESSION_KEY]: vaultData } = await chrome.storage.session.get(SESSION_KEY);
  if (!vaultData) return;                       // already locked, nothing to arm

  const { settings } = await chrome.storage.local.get('settings');
  const minutes = Number(settings?.autoLockMinutes) || 5;

  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  await chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
}

async function lockNow(reason) {
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  // Removing the session copy is the lock. Any open options page notices via
  // chrome.storage.onChanged and drops its in-memory key to match.
  await chrome.storage.session.remove(SESSION_KEY);
  console.log(`[FormPilot] vault locked (${reason})`);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) lockNow('idle timeout');
});

// --- Proactive form detection ----------------------------------------------
//
// Without this, FormPilot only ever acts when you open the popup and click —
// so a form you are already typing into goes unnoticed. This scans a page once
// it finishes loading, badges the toolbar icon with how many fields it could
// fill, and lets the content script offer an inline "Fill" chip.
//
// PRIVACY: this is the one place the extension scripts a page you did not
// explicitly ask about, so it is gated three ways. Nothing is injected unless
//   1. the page is http(s) — never chrome://, never the Web Store,
//   2. the vault is UNLOCKED — a locked vault means zero page scripting, and
//   3. the "suggest filling" setting is on.
// Detection never fills anything; it counts and offers.

function setBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' })
    .catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1B6FF3' }).catch(() => {});
}

/**
 * Inject the content script only if it is not already there. Tab activation
 * fires often, and re-running executeScript each time re-parses both files for
 * nothing — the load guard inside content.js makes it a no-op anyway.
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' });
    if (pong?.ok) return;
  } catch {
    // No listener yet, which is the normal first-visit case.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['lib/match.js', 'content.js']
  });
}

async function detectForms(tabId, url) {
  if (!/^https?:/i.test(url ?? '')) return;

  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.suggestFills === false) { setBadge(tabId, 0); return; }

  const { [SESSION_KEY]: vaultData } = await chrome.storage.session.get(SESSION_KEY);
  if (!vaultData) { setBadge(tabId, 0); return; }     // locked: touch nothing

  let host = '';
  try { host = new URL(url).hostname; } catch { /* opaque URL */ }
  const { siteMappings = {} } = await chrome.storage.local.get('siteMappings');

  try {
    await ensureContentScript(tabId);

    // KEY NAMES ONLY. This message goes to every http(s) page you open while
    // unlocked, so it must never carry a value - publicMeta() has none to give,
    // leaving what counting fields actually needs.
    const meta = publicMeta(vaultData);

    const reply = await chrome.tabs.sendMessage(tabId, {
      type: 'DETECT',
      keys: meta.keys,
      docKeys: meta.docKeys,
      docMimes: meta.docMimes,
      emails: meta.emails,
      customFields: meta.customFields,
      mappings: host ? (siteMappings[host] ?? {}) : {},
      highlight: settings?.highlightFills !== false,
      showChip: settings?.suggestFills !== false
    });

    setBadge(tabId, reply?.count ?? 0);
  } catch {
    // Restricted page, or the tab navigated away mid-scan. Not an error.
    setBadge(tabId, 0);
  }
}

// --- Releasing values to a page ---------------------------------------------
//
// The chip's Fill button asks for values here, because the content script has
// none. Everything that makes a fill safe is re-checked at this point rather
// than assumed from whenever detection ran.

const MAX_RELEASED_KEYS = 60;

/**
 * Everything about the vault a web page is allowed to know: which keys hold
 * something, and the labels needed to match a field to one. Deliberately
 * returns no values at all, so there is nothing here to leak by accident.
 *
 * Mirrors describeVault() in lib/match.js, which the popup uses for the same
 * purpose down the same code path. docKeys/docMimes are the document-upload
 * equivalent - a type and a mime, never the image itself - mirroring
 * describeDocs() in lib/match.js.
 */
function publicMeta(vaultData) {
  const documents = vaultData.documents ?? [];
  return {
    keys: Object.keys(expandValues(vaultData)),
    docKeys: documents.map((doc) => doc.type),
    docMimes: Object.fromEntries(documents.map((doc) => [doc.type, doc.mime])),
    customFields: (vaultData.customFields ?? [])
      .filter((field) => field?.label && field?.value)
      .map((field) => ({ label: field.label })),
    emails: (vaultData.emails ?? [])
      .filter((email) => email?.label && email?.value)
      .map((email) => ({ label: email.label }))
  };
}

// A standalone copy of lib/match.js's expandValues. The worker cannot load that
// file (it is a classic script for the content script's world, and the worker is
// a module), and duplicating twenty lines beats shipping the vault to a page.
// Keep in step with expandValues() in lib/match.js.
function expandValues(vaultData) {
  const fields = vaultData.fields ?? {};
  const emails = vaultData.emails ?? [];
  const customFields = vaultData.customFields ?? [];

  const values = {};
  for (const [key, value] of Object.entries(fields)) if (value) values[key] = value;

  for (const email of emails) {
    if (!email?.label || !email?.value) continue;
    values[`email:${email.label}`] = email.value;
    values['email:alternate'] ??= email.value;
  }
  if (!values.email && emails.length) values.email = emails[0]?.value ?? '';

  const full = (fields.fullName ?? '').trim();
  if (full) {
    const parts = full.split(/\s+/);
    if (parts.length > 1) {
      values.firstName ??= parts[0];
      values.lastName ??= parts[parts.length - 1];
      if (parts.length > 2) values.middleName ??= parts.slice(1, -1).join(' ');
    } else {
      values.firstName ??= full;
    }
  }

  for (const field of customFields) {
    if (field.label && field.value) values[`custom:${field.label}`] = field.value;
  }
  return values;
}

const MAX_RELEASED_DOC_TYPES = 20;

/**
 * Hand a content script the values and documents its plan needs, and nothing
 * else. One authorization path for both, rather than two to keep in sync -
 * everything below (real http(s) tab, suggestFills on, vault unlocked)
 * applies equally to a phone number and a signature image.
 *
 * @param {string[]} keys      vault key names the page's plan needs
 * @param {string[]} docTypes  document types the page's plan needs
 * @param {object} sender      the runtime sender, already checked to be ours
 */
async function releaseFill(keys, docTypes, sender) {
  // Must come from a content script in a real tab, on an ordinary web page.
  if (!sender?.tab?.id || !/^https?:/i.test(sender.tab.url ?? sender.url ?? '')) {
    return { ok: false, error: 'Fill can only be requested from a web page.' };
  }

  const { settings } = await chrome.storage.local.get('settings');
  if (settings?.suggestFills === false) {
    return { ok: false, error: 'Form suggestions are switched off.' };
  }

  const { [SESSION_KEY]: vaultData } = await chrome.storage.session.get(SESSION_KEY);
  if (!vaultData) return { ok: false, error: 'The vault is locked.' };

  const wanted = (Array.isArray(keys) ? keys : [])
    .filter((key) => typeof key === 'string' && key.length > 0 && key.length <= 200)
    .slice(0, MAX_RELEASED_KEYS);

  const all = expandValues(vaultData);
  const values = {};
  for (const key of wanted) {
    if (Object.hasOwn(all, key)) values[key] = all[key];
  }

  const wantedDocTypes = (Array.isArray(docTypes) ? docTypes : [])
    .filter((type) => typeof type === 'string' && type.length > 0 && type.length <= 100)
    .slice(0, MAX_RELEASED_DOC_TYPES);

  const docs = {};
  for (const doc of vaultData.documents ?? []) {
    if (wantedDocTypes.includes(doc.type) && !docs[doc.type]) {
      docs[doc.type] = { name: doc.name, mime: doc.mime, dataUrl: doc.dataUrl };
    }
  }

  armAutoLock();   // filling is activity
  return { ok: true, values, docs, highlight: settings?.highlightFills !== false };
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') detectForms(tabId, tab.url);
});

// Switching to a tab that loaded while the vault was still locked should pick
// the form up rather than leaving the badge blank until a reload.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    detectForms(tabId, tab.url);
  } catch { /* tab already gone */ }
});

// --- Who is allowed to ask -------------------------------------------------
//
// onMessage only ever delivers messages from this extension (no
// externally_connectable is declared, and web pages cannot reach it at all), but
// "from this extension" still covers two very different callers: our privileged
// pages, and a content script living inside somebody else's web page.
//
// Resetting the auto-lock clock is a privileged-page job. If a content script
// could send ACTIVITY, a page that kept it busy would hold the vault unlocked
// indefinitely - the idle timeout would simply never fire.

function fromOwnExtension(sender) {
  return sender?.id === chrome.runtime.id;
}

/**
 * True only for the popup and the options page, never for a content script.
 *
 * Cannot use `!sender.tab` to tell them apart: options_ui.open_in_tab is true,
 * so options.html runs inside a real tab and Chrome populates sender.tab for it
 * exactly like it would for a content script. The origin is what actually
 * differs - a content script's sender.url is the PAGE it was injected into,
 * never this extension's own chrome-extension:// origin - so that check alone
 * is both necessary and sufficient.
 */
function fromExtensionPage(sender) {
  return fromOwnExtension(sender)
    && (sender.url ?? '').startsWith(chrome.runtime.getURL(''));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!fromOwnExtension(sender)) {
    sendResponse({ ok: false, error: 'Rejected: unknown sender.' });
    return false;
  }

  switch (message?.type) {
    case 'ACTIVITY':
      // Any interaction pushes the deadline out. Fire-and-forget.
      if (!fromExtensionPage(sender)) {
        sendResponse({ ok: false, error: 'Rejected: a page cannot defer auto-lock.' });
        return false;
      }
      armAutoLock();
      sendResponse({ ok: true });
      return false;

    case 'REQUEST_FILL':
      // The in-page chip asking for the values and documents it is about to write.
      releaseFill(message.keys, message.docTypes, sender).then(sendResponse);
      return true;

    case 'LOCK_NOW':
      // Locking early is always allowed: it can only ever reduce exposure.
      lockNow(message.reason ?? 'requested').then(() => sendResponse({ ok: true }));
      return true;

    case 'PING':
      // Used by the popup's button to prove popup <-> worker wiring works.
      sendResponse({
        ok: true,
        from: 'background',
        version: chrome.runtime.getManifest().version,
        at: Date.now()
      });
      return false; // responded synchronously

    case 'GET_SETTINGS':
      // Async work: return true so Chrome keeps the message channel open until
      // sendResponse is called.
      chrome.storage.local.get('settings').then(({ settings }) => {
        sendResponse({ ok: true, settings: settings ?? null });
      });
      return true;

    default:
      sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
      return false;
  }
});
