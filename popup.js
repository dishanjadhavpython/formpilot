// FormPilot - popup: drive the autofill
//
// The popup cannot decrypt anything itself - the vault key is non-extractable
// and lives in the options page. Instead, unlocking publishes the decrypted
// fields to chrome.storage.session, which is held in memory, never written to
// disk, and readable only by trusted extension contexts (not content scripts).
// This popup reads that cache and hands the specific values to the content
// script it injects.

const SESSION_KEY = 'vaultData';
const M = globalThis.FormPilotMatch;   // from lib/match.js, loaded just above

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
  // Keep the base class: the colours are defined as .status.ok / .err / .warn,
  // so dropping "status" here would leave the text unstyled.
  statusEl.className = ['status', kind].filter(Boolean).join(' ');
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

/** Mirror the Tinted / Clear choice the options page stores. */
async function applyGlassMode() {
  const { settings } = await chrome.storage.local.get('settings');
  const mode = settings?.glassMode ?? 'tinted';
  document.documentElement.classList.toggle('lg-clear', mode === 'clear');
  document.documentElement.classList.toggle('lg-tinted', mode !== 'clear');
}

async function boot() {
  await applyGlassMode();
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

  // Opening the popup counts as activity: it pushes the idle auto-lock out.
  if (unlocked) chrome.runtime.sendMessage({ type: 'ACTIVITY' }).catch(() => {});

  if (restricted) {
    setStatus('Chrome does not allow extensions to run on this page.', 'warn');
  }
  // No "vault is locked" status here — #lockedNote above already says it, and
  // two copies of the same sentence reads as a bug.
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
  if (!vaultData) {
    // Most likely the idle timer fired since this popup was last opened.
    boot();
    throw new Error('The vault locked itself. Unlock it again to fill.');
  }
  chrome.runtime.sendMessage({ type: 'ACTIVITY' }).catch(() => {});
  return vaultData;
}

// --- Fill -------------------------------------------------------------------

/** One place that turns a fill outcome into a sentence, for both passes. */
function reportFill(filled, total, skipped) {
  if (filled > 0) {
    setStatus(`Filled ${filled} of ${total}. Review before submitting.`, 'ok');
  } else if (total === 0) {
    setStatus('No fillable fields found on this page.', 'warn');
  } else if (skipped.alreadyFilled > 0) {
    setStatus(`Filled 0 of ${total} - those fields already had values.`, 'warn');
  } else {
    setStatus(`Filled 0 of ${total}. Try "Teach fields" to map them.`, 'warn');
  }
}

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

    // Two passes, and the split is the point.
    //
    // PASS 1 asks the page what it WOULD fill, given only the NAMES of the keys
    // this vault can answer. No value leaves the popup, so a page that turns out
    // to want nothing never sees anything.
    const meta = M.describeVault(vaultData.fields, vaultData.customFields, vaultData.emails);
    const payload = {
      keys: meta.keys,
      customFields: meta.customFields,
      emails: meta.emails,
      mappings: host ? (siteMappings[host] ?? {}) : {},
      highlight: settings?.highlightFills !== false
    };

    const plan = await send({ type: 'PLAN', ...payload });
    if (!plan?.ok) throw new Error(plan?.error ?? 'The page did not respond.');

    if (plan.count === 0) {
      reportFill(0, plan.total, plan.skipped ?? {});
      return;
    }

    // PASS 2 sends the values for those keys only. A page with one email box
    // receives one email address, not the address book, the phone number and
    // the PAN.
    const all = M.expandValues(vaultData.fields, vaultData.customFields, vaultData.emails);
    const reply = await send({
      type: 'FILL',
      ...payload,
      values: M.pickValues(all, plan.keys)
    });

    if (!reply?.ok) throw new Error(reply?.error ?? 'The page did not respond.');

    // Pass 2 can still come back with nothing if the page changed underneath us.
    reportFill(reply.filled, reply.total, reply.skipped ?? {});
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

    // Key names only - the label picker lists what the vault CAN answer, and
    // has never needed to know any of the answers.
    const meta = M.describeVault(vaultData.fields, vaultData.customFields, vaultData.emails);
    const reply = await send({ type: 'TEACH', keys: meta.keys });
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

// Feature tiles: open the vault page scrolled to that section. The hash is read
// by options.js once the right view has rendered.
for (const tile of document.querySelectorAll('[data-open]')) {
  tile.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`options.html#${tile.dataset.open}`) });
    window.close();
  });
}

lockLink.addEventListener('click', async () => {
  // Dropping the session cache is enough: the key itself was never here.
  await chrome.storage.session.remove(SESSION_KEY);
  setStatus('Vault locked.', 'ok');
  boot();
});

boot();
