// FormPilot - popup: drive the autofill
//
// The popup cannot decrypt anything itself - the vault key is non-extractable
// and lives in the options page. Instead, unlocking publishes the decrypted
// fields to chrome.storage.session, which is held in memory, never written to
// disk, and readable only by trusted extension contexts (not content scripts).
// This popup reads that cache and hands the specific values to the content
// script it injects.

const SESSION_KEY = 'vaultData';

const fillBtn = document.getElementById('fillBtn');
const teachBtn = document.getElementById('teachBtn');
const statusEl = document.getElementById('status');
const badge = document.getElementById('lockBadge');
const lockedNote = document.getElementById('lockedNote');
const siteEl = document.getElementById('site');
const lockLink = document.getElementById('lockLink');

let statusTimer;

function setStatus(text, kind = '', autoClearMs = 0) {
  clearTimeout(statusTimer);
  statusEl.textContent = text;
  statusEl.className = kind;
  if (text && autoClearMs) statusTimer = setTimeout(() => setStatus(''), autoClearMs);
}

function safeHost(url) {
  try {
    const { hostname, protocol } = new URL(url);
    return hostname || protocol.replace(':', '');
  } catch {
    return null;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Pages the browser refuses to let extensions script.
function isRestricted(url = '') {
  return /^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)
      || url.startsWith('https://chromewebstore.google.com')
      || url.startsWith('https://chrome.google.com/webstore');
}

// --- Boot -------------------------------------------------------------------

async function boot() {
  const tab = await activeTab();
  const host = safeHost(tab?.url);
  siteEl.textContent = host ? `Current tab: ${host}` : 'No active page.';

  const { [SESSION_KEY]: vaultData } = await chrome.storage.session.get(SESSION_KEY);
  const unlocked = Boolean(vaultData);

  badge.textContent = unlocked ? 'Unlocked' : 'Locked';
  badge.classList.toggle('unlocked', unlocked);
  lockedNote.classList.toggle('hidden', unlocked);
  lockLink.classList.toggle('hidden', !unlocked);

  const restricted = isRestricted(tab?.url ?? '');
  fillBtn.disabled = !unlocked || restricted;
  teachBtn.disabled = !unlocked || restricted;

  if (restricted) {
    setStatus('Chrome does not allow extensions to run on this page.', 'warn');
  } else if (!unlocked) {
    setStatus('Unlock the vault to enable filling.', 'warn');
  }
}

// --- Injection --------------------------------------------------------------

// The content script is injected on demand rather than declared in the
// manifest, so it never runs on a page you did not ask it to.
async function injectInto(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['lib/match.js', 'content.js']
  });
}

async function withContentScript(action) {
  const tab = await activeTab();
  if (!tab?.id) throw new Error('No active tab.');
  if (isRestricted(tab.url ?? '')) throw new Error('This page cannot be scripted.');

  await injectInto(tab.id);
  return { tab, send: (message) => chrome.tabs.sendMessage(tab.id, message) };
}

async function vaultOrThrow() {
  const { [SESSION_KEY]: vaultData } = await chrome.storage.session.get(SESSION_KEY);
  if (!vaultData) throw new Error('Vault is locked.');
  return vaultData;
}

// --- Fill -------------------------------------------------------------------

fillBtn.addEventListener('click', async () => {
  fillBtn.disabled = true;
  setStatus('Scanning the page...');

  try {
    const vaultData = await vaultOrThrow();
    const { tab, send } = await withContentScript();

    // Per-site corrections the user taught us, if any.
    const host = safeHost(tab.url);
    const { siteMappings = {} } = await chrome.storage.local.get('siteMappings');
    const { settings } = await chrome.storage.local.get('settings');

    const reply = await send({
      type: 'FILL',
      fields: vaultData.fields ?? {},
      customFields: vaultData.customFields ?? [],
      mappings: host ? (siteMappings[host] ?? {}) : {},
      highlight: settings?.highlightFills !== false
    });

    if (!reply?.ok) throw new Error(reply?.error ?? 'The page did not respond.');

    const { filled, total, skipped } = reply;
    if (filled === 0 && total === 0) {
      setStatus('No fillable fields found on this page.', 'warn');
    } else if (filled === 0) {
      setStatus(
        skipped.alreadyFilled > 0
          ? `Filled 0 of ${total} - those fields already had values.`
          : `Filled 0 of ${total}. Try "Teach fields" to map them.`,
        'warn'
      );
    } else {
      setStatus(`Filled ${filled} of ${total}. Review before submitting.`, 'ok');
    }
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    fillBtn.disabled = false;
  }
});

// --- Teach ------------------------------------------------------------------

teachBtn.addEventListener('click', async () => {
  teachBtn.disabled = true;
  try {
    const vaultData = await vaultOrThrow();
    const { send } = await withContentScript();

    const reply = await send({
      type: 'TEACH',
      fields: vaultData.fields ?? {},
      customFields: vaultData.customFields ?? []
    });
    if (!reply?.ok) throw new Error(reply?.error ?? 'The page did not respond.');

    setStatus('Click a field on the page to label it. Esc to finish.', 'ok');
    // The popup closes as soon as focus moves to the page, which is fine -
    // teach mode lives in the content script from here on.
    window.close();
  } catch (err) {
    setStatus(err.message, 'err');
  } finally {
    teachBtn.disabled = false;
  }
});

// --- Footer -----------------------------------------------------------------

document.getElementById('optionsLink').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

lockLink.addEventListener('click', async () => {
  // Dropping the session cache is enough: the key itself was never here.
  await chrome.storage.session.remove(SESSION_KEY);
  setStatus('Vault locked.', 'ok');
  boot();
});

boot();
