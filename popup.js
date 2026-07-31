// FormPilot - popup script
//
// Phase 0 scope: prove the popup opens and can talk to the service worker.
// Phase 2 replaces the button below with "Fill this form", which will send the
// unlocked vault data to the content script via chrome.tabs.sendMessage.

const checkBtn = document.getElementById('checkBtn');
const statusEl = document.getElementById('status');
const optionsLink = document.getElementById('optionsLink');

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

checkBtn.addEventListener('click', async () => {
  checkBtn.disabled = true;
  setStatus('Checking...');

  try {
    // Wakes the service worker if it is asleep, then waits for its reply.
    const reply = await chrome.runtime.sendMessage({ type: 'PING' });

    if (reply?.ok) {
      // activeTab lets us read the current tab's URL without a broad prompt.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const host = tab?.url ? safeHost(tab.url) : 'this page';
      setStatus(`Service worker OK (v${reply.version}). Ready on ${host}.`, 'ok');
    } else {
      setStatus(reply?.error ?? 'No response from the service worker.', 'err');
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'err');
  } finally {
    checkBtn.disabled = false;
  }
});

optionsLink.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

// chrome:// and file:// URLs have no useful host; fall back to the scheme.
function safeHost(url) {
  try {
    const { hostname, protocol } = new URL(url);
    return hostname || protocol.replace(':', '');
  } catch {
    return 'this page';
  }
}
