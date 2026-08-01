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

    const reply = await chrome.tabs.sendMessage(tabId, {
      type: 'DETECT',
      fields: vaultData.fields ?? {},
      emails: vaultData.emails ?? [],
      customFields: vaultData.customFields ?? [],
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case 'ACTIVITY':
      // Any interaction pushes the deadline out. Fire-and-forget.
      armAutoLock();
      sendResponse({ ok: true });
      return false;

    case 'LOCK_NOW':
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
