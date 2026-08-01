// FormPilot - content script: detect fields, fill them, never submit
//
// Injected on demand by the popup (chrome.scripting.executeScript), not declared
// in the manifest - so it only ever runs on a page you explicitly asked to fill.
// The guard below makes repeat injection a no-op.
//
// THE SAFETY RULES, enforced below and not negotiable:
//   * Nothing in this file calls form.submit(), clicks a submit control, or
//     synthesises an Enter keypress. Filling and submitting stay separate.
//   * input[type=password] is skipped unconditionally.
//   * Fields that already have a value are left alone, so a fill can never
//     destroy something you typed yourself.

if (!globalThis.__formPilotContentLoaded) {
  globalThis.__formPilotContentLoaded = true;

  const M = globalThis.FormPilotMatch;
  const UI_HOST_ID = '__formpilot_ui__';

  // Input types that are never fillable from the vault. `password` is the one
  // that matters; the rest are simply not text.
  const SKIP_TYPES = new Set([
    'password', 'hidden', 'submit', 'button', 'reset', 'image', 'file',
    'checkbox', 'radio', 'range', 'color'
  ]);

  let outlined = [];        // elements we styled, so we can undo it next run
  let teachMode = false;

  // ==========================================================================
  // Messaging
  // ==========================================================================

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    try {
      switch (message?.type) {
        case 'PING_CONTENT':
          sendResponse({ ok: true });
          break;
        case 'FILL':
          sendResponse({ ok: true, ...fillForm(message) });
          break;
        case 'DETECT':
          // Look, count, offer — never fill. Filling is always a click away.
          sendResponse({ ok: true, count: detect(message) });
          break;

        case 'TEACH': {
          // Offer every key we actually hold a value for, so the user cannot
          // map a field to something the vault cannot fill.
          const keys = Object.keys(M.expandValues(message.fields, message.customFields, message.emails));
          enterTeachMode(keys.sort());
          sendResponse({ ok: true, keys: keys.length });
          break;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message: ${message?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return false;   // all branches respond synchronously
  });

  // ==========================================================================
  // Finding fields
  // ==========================================================================

  function isFillable(el) {
    if (el.disabled || el.readOnly) return false;

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && SKIP_TYPES.has((el.type || 'text').toLowerCase())) return false;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
      return false;
    }

    // display:none on an ANCESTOR. A fixed-position element legitimately has no
    // offsetParent, so it is exempt.
    if (el.offsetParent === null && style.position !== 'fixed') return false;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    // Parked off-screen. `position:absolute; left:-9999px` is THE honeypot
    // trick: the field is fully rendered, so size, visibility, display and
    // opacity all look normal and every other check passes. Filling it is how
    // a form decides you are a bot.
    //
    // Measured in DOCUMENT coordinates, not viewport ones - a legitimate field
    // the user has simply scrolled past also has a negative viewport rect.
    const docRight = rect.right + window.scrollX;
    const docBottom = rect.bottom + window.scrollY;
    if (docRight <= 0 || docBottom <= 0) return false;

    // Collapsed by clip / clip-path - the "visually hidden" pattern.
    if (style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)') return false;

    return true;
  }

  function candidates() {
    return [...document.querySelectorAll('input, select, textarea')].filter(isFillable);
  }

  // ==========================================================================
  // Filling
  // ==========================================================================

  // React (and Vue) install their own setter on the value property and track
  // changes through it. Assigning el.value directly bypasses that tracker, the
  // framework never sees the change, and the value vanishes on the next render.
  // Calling the *native* prototype setter is the standard fix.
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
      HTMLInputElement.prototype;

    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  // Sites listen for one or the other, so send both. Note there is deliberately
  // no 'keydown'/'keypress' here - synthesising Enter could submit the form.
  function announce(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Our dob is stored as yyyy-mm-dd (from <input type=date>). A text input that
  // wants dd/mm/yyyy usually says so in its placeholder - cheap win, so use it.
  function formatDate(iso, el) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return iso;
    const [, year, month, day] = match;
    if ((el.type || '').toLowerCase() === 'date') return iso;

    const hint = `${el.placeholder || ''} ${el.getAttribute('data-format') || ''}`.toLowerCase();
    if (hint.includes('dd/mm/yyyy')) return `${day}/${month}/${year}`;
    if (hint.includes('mm/dd/yyyy')) return `${month}/${day}/${year}`;
    if (hint.includes('dd-mm-yyyy')) return `${day}-${month}-${year}`;
    return iso;
  }

  function fillSelect(el, value) {
    const want = String(value).trim().toLowerCase();
    for (const option of el.options) {
      if (option.value.toLowerCase() === want || option.textContent.trim().toLowerCase() === want) {
        setNativeValue(el, option.value);
        return true;
      }
    }
    if (want.length > 2) {
      for (const option of el.options) {
        if (option.textContent.trim().toLowerCase().includes(want)) {
          setNativeValue(el, option.value);
          return true;
        }
      }
    }
    return false;
  }

  function fillOne(el, value) {
    if (el.tagName.toLowerCase() === 'select') return fillSelect(el, value);

    const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value, el) : String(value);
    setNativeValue(el, text);
    return true;
  }

  /**
   * Work out what WOULD be filled, without touching the page.
   * Shared by the fill itself and by detection, so a suggestion can never
   * promise a number the fill then fails to deliver.
   */
  function planFill({ fields = {}, customFields = [], emails = [], mappings = {} }) {
    // fullName also answers first/last name; custom labels become matchable keys.
    const values = M.expandValues(fields, customFields, emails);
    const dictionary = M.buildDictionary(customFields, emails);
    const all = candidates();

    // Per-site mappings the user taught us win over every guess.
    const taught = new Map();
    for (const [selector, key] of Object.entries(mappings)) {
      try {
        const el = document.querySelector(selector);
        if (el && isFillable(el)) taught.set(el, key);
      } catch {
        /* a stale selector from an older page version - ignore it */
      }
    }

    const plan = [];
    const skipped = { alreadyFilled: 0, noMatch: 0, noValue: 0 };

    for (const el of all) {
      // 1. taught mapping  2. autocomplete attribute  3. text signals
      const guess = M.inferKey(M.describeField(el), dictionary);
      const key = taught.get(el) ?? M.fromAutocomplete(el) ?? guess?.key ?? null;

      if (!key) { skipped.noMatch++; continue; }

      const value = values[key];
      if (value === undefined || value === '') { skipped.noValue++; continue; }

      // Never overwrite something already in the box.
      if (el.value && el.value.trim() !== '') { skipped.alreadyFilled++; continue; }

      plan.push({
        el, key, value,
        source: taught.has(el) ? 'taught' : (M.fromAutocomplete(el) ? 'autocomplete' : 'guess')
      });
    }

    // "Y" is the number of fields we could plausibly have filled: everything
    // visible and fillable, minus the ones we had no vault value for.
    const total = Math.max(all.length - skipped.noValue, plan.length);
    return { plan, skipped, total };
  }

  function fillForm(message) {
    clearOutlines();

    const { plan, skipped, total } = planFill(message);
    const highlight = message.highlight !== false;
    const filled = [];

    for (const { el, key, value, source } of plan) {
      if (!fillOne(el, value)) continue;
      announce(el);
      filled.push({ key, source });
      if (highlight) outline(el);
    }

    showToast(filled.length, total, skipped);
    return { filled: filled.length, total, skipped, details: filled };
  }

  // ==========================================================================
  // Detection: notice a fillable form and offer, rather than waiting to be asked
  // ==========================================================================

  let suggestionDismissed = false;
  let pendingPayload = null;      // kept so the chip's Fill button has the data

  /**
   * Count what could be filled and, if anything can, show the suggestion chip.
   * Returns the count so the service worker can badge the toolbar icon.
   */
  function detect(message) {
    pendingPayload = message;
    const { plan } = planFill(message);

    if (plan.length > 0) {
      if (message.showChip !== false) showSuggestion(plan.length);
    } else {
      // Nothing yet. Forms rendered late by a framework are the common case, so
      // re-check once the user actually touches a field rather than giving up.
      armLateDetect();
    }
    return plan.length;
  }

  function armLateDetect() {
    if (suggestionDismissed) return;
    document.addEventListener('focusin', onLateFocus, true);
  }

  function onLateFocus(event) {
    if (suggestionDismissed || !pendingPayload) return;
    const el = event.target;
    if (!(el instanceof Element) || !el.matches('input, select, textarea')) return;

    const { plan } = planFill(pendingPayload);
    if (plan.length === 0) return;

    document.removeEventListener('focusin', onLateFocus, true);
    if (pendingPayload.showChip !== false) showSuggestion(plan.length);
  }

  function showSuggestion(count) {
    if (suggestionDismissed) return;

    const shadow = uiRoot();
    clearTimeout(showToast.timer);

    const slot = shadow.getElementById('slot');
    slot.replaceChildren();

    const card = document.createElement('div');
    card.className = 'card';

    const title = document.createElement('strong');
    title.textContent = 'FormPilot';

    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = `Can fill ${count} field${count === 1 ? '' : 's'} here.`;

    const row = document.createElement('div');
    row.className = 'row';

    const fill = document.createElement('button');
    fill.type = 'button';
    fill.textContent = 'Fill';
    fill.addEventListener('click', () => {
      if (pendingPayload) fillForm(pendingPayload);   // replaces this with its own toast
    });

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'ghost';
    dismiss.textContent = 'Not now';
    dismiss.addEventListener('click', () => {
      suggestionDismissed = true;
      document.removeEventListener('focusin', onLateFocus, true);
      removeUi();
    });

    row.append(fill, dismiss);
    card.append(title, note, row);
    slot.append(card);
  }

  // ==========================================================================
  // Review highlighting
  // ==========================================================================

  function outline(el) {
    outlined.push({ el, outline: el.style.outline, offset: el.style.outlineOffset });
    el.style.setProperty('outline', '2px solid #1B6FF3', 'important');   /* --accent */
    el.style.setProperty('outline-offset', '1px', 'important');
  }

  function clearOutlines() {
    for (const { el, outline, offset } of outlined) {
      el.style.outline = outline;
      el.style.outlineOffset = offset;
    }
    outlined = [];
  }

  // ==========================================================================
  // In-page UI (Shadow DOM so the host page's CSS cannot reach it)
  // ==========================================================================

  function uiRoot() {
    let host = document.getElementById(UI_HOST_ID);
    if (host) return host.shadowRoot;

    host = document.createElement('div');
    host.id = UI_HOST_ID;
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('inset', 'auto 16px 16px auto', 'important');

    const shadow = host.attachShadow({ mode: 'open' });

    // These styles mirror styles/one-ui.css. A Shadow DOM rendered into a
    // third-party page cannot reach the extension's stylesheet, and CSS custom
    // properties inherit from the *host page*, where our tokens do not exist -
    // so the values are redeclared on :host. Keep the two in sync by hand.
    shadow.innerHTML = `
      <style>
        :host {
          --accent:#1B6FF3; --surface:#17181B;
          --r-lg:22px; --r-md:16px; --r-pill:999px;
          --s2:8px; --s3:12px; --s4:16px;
          --shadow:0 8px 28px rgba(0,0,0,0.45);
          --ease:cubic-bezier(0.22,0.61,0.36,1);
          --font:"Inter","SamsungOne","system-ui",-apple-system,"Segoe UI",Roboto,sans-serif;
        }
        :host, * { box-sizing: border-box; }
        /* Liquid Glass popover. Mirrors styles/liquid-glass.css — a Shadow
           DOM on someone else's page cannot reach our stylesheet or tokens. */
        .card {
          position: relative;
          isolation: isolate;
          font: 450 13px/1.45 var(--font);
          background: color-mix(in srgb, var(--accent) 82%, transparent);
          -webkit-backdrop-filter: blur(24px) saturate(180%);
          backdrop-filter: blur(24px) saturate(180%);
          border: 1px solid rgba(255,255,255,0.35);
          color: #fff;
          padding: var(--s3) var(--s4);
          border-radius: var(--r-lg);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.45), var(--shadow);
          max-width: 300px;
        }
        .card::before {
          content: "";
          position: absolute; inset: 0; z-index: 0;
          border-radius: inherit; pointer-events: none;
          background: linear-gradient(180deg, rgba(255,255,255,0.28) 0%, transparent 46%);
        }
        .card > * { position: relative; z-index: 1; }
        .card.teach { background: color-mix(in srgb, var(--surface) 80%, transparent); }
        .card strong { display: block; font-size: 14px; font-weight: 600; margin-bottom: 2px; }
        .card .muted { opacity: .85; }
        select, button {
          font: inherit; border: none; margin-top: var(--s2);
        }
        select {
          width: 100%; color: #17181C; background: #fff;
          border-radius: var(--r-md); padding: 8px var(--s3);
        }
        .row { display: flex; gap: var(--s2); }
        button {
          flex: 1; padding: 8px var(--s3);
          border-radius: var(--r-pill);
          background: #fff; color: var(--accent); font-weight: 600; cursor: pointer;
          transition: transform .12s var(--ease);
        }
        button:active { transform: scale(0.97); }
        button.ghost { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,.45); }
      </style>
      <div id="slot"></div>`;
    document.documentElement.append(host);
    return shadow;
  }

  function removeUi() {
    document.getElementById(UI_HOST_ID)?.remove();
  }

  function showToast(filled, total, skipped) {
    const shadow = uiRoot();
    const extra = skipped.alreadyFilled
      ? ` ${skipped.alreadyFilled} already had a value.`
      : '';

    const slot = shadow.getElementById('slot');
    slot.replaceChildren();

    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('strong');
    title.textContent = `FormPilot filled ${filled} of ${total}`;
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = `Review before you submit.${extra}`;
    card.append(title, note);
    slot.append(card);

    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(removeUi, 6000);
  }

  // ==========================================================================
  // Teach mode: click a field, say what it is, remember it for this site
  // ==========================================================================

  function enterTeachMode(keys) {
    if (teachMode) return;
    teachMode = true;

    const shadow = uiRoot();
    clearTimeout(showToast.timer);
    renderTeachPrompt(shadow, 'Click a field to label it. Esc when you are done.');

    let hovered = null;

    const onMove = (event) => {
      const el = event.target;
      if (el === hovered) return;
      if (hovered) hovered.style.removeProperty('box-shadow');
      hovered = (el instanceof Element && el.matches('input, select, textarea') && isFillable(el)) ? el : null;
      if (hovered) hovered.style.setProperty('box-shadow', '0 0 0 3px #f0a500', 'important');
    };

    const onClick = (event) => {
      const el = event.target;
      if (!(el instanceof Element) || !el.matches('input, select, textarea')) return;
      event.preventDefault();
      event.stopPropagation();
      askForLabel(el, keys, shadow);
    };

    const onKey = (event) => {
      if (event.key === 'Escape') exit();
    };

    function exit() {
      teachMode = false;
      if (hovered) hovered.style.removeProperty('box-shadow');
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      removeUi();
    }

    // Capture phase, so we see the click before the page's own handlers do.
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function renderTeachPrompt(shadow, text) {
    const slot = shadow.getElementById('slot');
    slot.replaceChildren();
    const card = document.createElement('div');
    card.className = 'card teach';
    const title = document.createElement('strong');
    title.textContent = 'Teach FormPilot';
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = text;
    card.append(title, note);
    slot.append(card);
  }

  function askForLabel(el, keys, shadow) {
    const slot = shadow.getElementById('slot');
    slot.replaceChildren();

    const card = document.createElement('div');
    card.className = 'card teach';
    const title = document.createElement('strong');
    title.textContent = 'What is this field?';
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = el.name || el.id || el.placeholder || el.tagName.toLowerCase();

    const select = document.createElement('select');
    for (const key of keys) {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = key.startsWith('custom:') ? key.slice(7) : key;
      select.append(option);
    }

    const row = document.createElement('div');
    row.className = 'row';
    const save = document.createElement('button');
    save.textContent = 'Save';
    const skip = document.createElement('button');
    skip.className = 'ghost';
    skip.textContent = 'Cancel';

    save.addEventListener('click', async () => {
      await saveMapping(el, select.value);
      renderTeachPrompt(shadow, `Saved. Click another field, or press Esc.`);
    });
    skip.addEventListener('click', () => {
      renderTeachPrompt(shadow, 'Click a field to label it. Esc when you are done.');
    });

    row.append(save, skip);
    card.append(title, note, select, row);
    slot.append(card);
  }

  /** A selector stable enough to find this field again on the next visit. */
  function stableSelector(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return `#${CSS.escape(el.id)}`;
    }
    if (el.name) {
      const selector = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      if (document.querySelectorAll(selector).length === 1) return selector;
    }

    // Fall back to a structural path.
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && path.length < 6) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      path.unshift(part);
      if (node.id) { path[0] = `#${CSS.escape(node.id)}`; break; }
      node = parent;
    }
    return path.join(' > ');
  }

  // Mappings hold a hostname, a selector and a vault field NAME - never a value.
  async function saveMapping(el, key) {
    const host = location.hostname;
    const selector = stableSelector(el);

    const { siteMappings = {} } = await chrome.storage.local.get('siteMappings');
    siteMappings[host] = { ...(siteMappings[host] ?? {}), [selector]: key };
    await chrome.storage.local.set({ siteMappings });
  }
}
