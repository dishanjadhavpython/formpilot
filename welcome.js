// FormPilot - the page you land on after installing.
//
// Opened once, by background.js, on reason === 'install'. Its whole job is to
// answer the two questions a new user actually has - "what is this" and "what
// does it want from me" - before the extension asks for a passphrase it can
// never help them recover.
//
// It reads nothing and writes nothing. No storage, no vault, no messages.

const settings = { glassMode: 'tinted' };

/** Mirror the Tinted / Clear choice the options page stores. */
async function applyGlassMode() {
  try {
    const stored = await chrome.storage.local.get('settings');
    settings.glassMode = stored.settings?.glassMode ?? 'tinted';
  } catch { /* first run, before any settings exist */ }

  const clear = settings.glassMode === 'clear';
  document.documentElement.classList.toggle('lg-clear', clear);
  document.documentElement.classList.toggle('lg-tinted', !clear);
}

document.getElementById('setupBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('demoBtn').addEventListener('click', () => {
  window.location.href = 'demo.html';
});

applyGlassMode();
