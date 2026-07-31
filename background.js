// FormPilot - background service worker (Manifest V3)
//
// Important MV3 detail: this worker is EPHEMERAL. Chrome starts it when an event
// fires and shuts it down when it goes idle, which wipes every global variable.
// So never keep real state in a variable up here - put it in chrome.storage.
// (In Phase 1 the decrypted vault key is the one exception: it lives only in the
// page that unlocked it, in memory, and is never persisted.)

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

chrome.runtime.onStartup.addListener(() => {
  console.log('[FormPilot] browser started, service worker awake');
});

// --- Messaging ------------------------------------------------------------
//
// The popup, the options page and (later) the content script all run in separate
// contexts and cannot call each other's functions directly. They talk through
// chrome.runtime.sendMessage / chrome.tabs.sendMessage. This is the single entry
// point for messages aimed at the service worker.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
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
