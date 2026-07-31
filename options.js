// FormPilot - options page script
//
// Phase 0 scope: a working read/write round-trip against chrome.storage.local,
// which proves the "storage" permission and this page are wired up correctly.
// Phase 1 grows this page into the encrypted vault (passphrase setup + unlock),
// Phase 3 adds the image resize tool, Phase 4 adds OCR.

const autoLockEl = document.getElementById('autoLock');
const highlightEl = document.getElementById('highlight');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

const DEFAULTS = {
  autoLockMinutes: 5,
  highlightFills: true
};

let statusTimer;

function setStatus(text, kind = '') {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.className = kind;
  if (text) statusTimer = setTimeout(() => setStatus(''), 2500);
}

async function load() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULTS, ...(settings ?? {}) };
  autoLockEl.value = merged.autoLockMinutes;
  highlightEl.checked = merged.highlightFills;
}

async function save() {
  const minutes = Number(autoLockEl.value);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    setStatus('Auto-lock must be between 1 and 120 minutes.', 'err');
    return;
  }

  // Read-modify-write so we keep keys other phases may have added (installedAt).
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.storage.local.set({
    settings: {
      ...(settings ?? {}),
      autoLockMinutes: minutes,
      highlightFills: highlightEl.checked
    }
  });

  setStatus('Saved.', 'ok');
}

saveBtn.addEventListener('click', save);

// Keep this page in sync if another context (popup, service worker) writes settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) load();
});

load();
