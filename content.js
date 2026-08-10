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
//
// THE DATA RULE, which shapes the whole file:
//   This script runs inside a web page. Treat every value that reaches it as
//   spent. So detection - which happens on ordinary browsing, on sites you have
//   no intention of filling - is given KEY NAMES ONLY: enough to know `phone`
//   can be answered, never the number. Real values arrive only in a FILL, only
//   for the fields that fill is about to write, and only after a trusted click.

if (!globalThis.__formPilotContentLoaded) {
  globalThis.__formPilotContentLoaded = true;

  const M = globalThis.FormPilotMatch;
  const UI_HOST_ID = '__formpilot_ui__';

  // The page must not be able to reach our UI. With an open shadow root any
  // script on the page could do
  //     document.getElementById(UI_HOST_ID).shadowRoot.querySelector('button')
  // and drive the Fill button itself. Closed, plus the isTrusted check on the
  // button, means a fill needs a real human click.
  let uiShadow = null;

  // Ceiling on how many values one fill may pull out of the vault. A page with
  // 400 inputs is not a form.
  const MAX_FILL_KEYS = 60;
  const MAX_FILL_DOC_TYPES = 20;

  // Input types this pass never fills. `password` is the one that matters; most
  // of the rest are simply not text. Two are here for their own reasons:
  //
  //   radio    - handled separately, by radioGroups() below. A single radio in
  //              isolation is meaningless; the group is the unit.
  //
  //   checkbox - REFUSED ON PURPOSE, permanently, and not for want of effort.
  //              A checkbox on a form of this kind is overwhelmingly a
  //              statement the user is making: "I hereby declare the above to
  //              be true", "I accept the terms", "I consent to...". Ticking one
  //              makes that assertion on their behalf, which is the same
  //              category of act as pressing Submit for them - and CLAUDE.md's
  //              first hard rule exists precisely because that is not ours to
  //              do. The handful of checkboxes that carry mere facts are not
  //              worth the ones that do not.
  const SKIP_TYPES = new Set([
    'password', 'hidden', 'submit', 'button', 'reset', 'image', 'file',
    'checkbox', 'radio', 'range', 'color'
  ]);

  let outlined = [];        // elements we styled, so we can undo it next run
  let teachMode = false;

  // ==========================================================================
  // Messaging
  // ==========================================================================

  // Only our own extension may drive this script. chrome.runtime.onMessage does
  // not deliver messages from the page itself (content scripts run in an
  // isolated world, and no externally_connectable is declared), but checking the
  // sender means that stays true even if that changes underneath us.
  function fromOwnExtension(sender) {
    return sender?.id === chrome.runtime.id;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!fromOwnExtension(sender)) {
      sendResponse({ ok: false, error: 'Rejected: not from FormPilot.' });
      return false;
    }
    try {
      switch (message?.type) {
        case 'PING_CONTENT':
          sendResponse({ ok: true });
          break;
        case 'FILL':
          sendResponse({ ok: true, ...fillForm(message) });
          break;

        case 'PLAN':
          // What WOULD be filled, so the caller can send back just those values.
          sendResponse({ ok: true, ...describePlan(message) });
          break;

        case 'DETECT':
          // Look, count, offer — never fill. Filling is always a click away.
          sendResponse({ ok: true, ...detect(message) });
          break;

        case 'TEACH': {
          // Key names only: the popup already worked out what the vault can
          // answer, so the label picker never needs a single value.
          const keys = [...safeKeys(message.keys)].sort();
          enterTeachMode(keys);
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
  // Payload hygiene
  // ==========================================================================

  /** Key names from a message, as a Set, with anything malformed dropped. */
  function safeKeys(keys) {
    if (!Array.isArray(keys)) return new Set();
    return new Set(keys.filter((key) => typeof key === 'string' && key.length > 0 && key.length <= 200));
  }

  /**
   * Site mappings are read back from storage, so treat them as untrusted input:
   * a hand-edited or corrupted store must not become a selector we run.
   */
  function safeMappings(mappings) {
    if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) return [];
    return Object.entries(mappings)
      .filter(([selector, key]) =>
        typeof selector === 'string' && selector.length > 0 && selector.length <= 500 &&
        typeof key === 'string' && key.length > 0 && key.length <= 200)
      .slice(0, 200);
  }

  // ==========================================================================
  // Finding fields
  // ==========================================================================

  // display:none on an ANCESTOR. A fixed-position element legitimately has no
  // offsetParent, so it is exempt. Shared by isFillable and isFillableDoc:
  // both need to know an element is actually reachable in the page's layout,
  // even though they disagree below on what counts as "visible enough".
  function isReachable(el, style) {
    if (style.display === 'none') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;

    // Parked off-screen. `position:absolute; left:-9999px` is THE honeypot
    // trick: the field is fully rendered, so size, visibility, display and
    // opacity all look normal and every other check passes. Filling it is how
    // a form decides you are a bot.
    //
    // Measured in DOCUMENT coordinates, not viewport ones - a legitimate field
    // the user has simply scrolled past also has a negative viewport rect.
    const rect = el.getBoundingClientRect();
    const docRight = rect.right + window.scrollX;
    const docBottom = rect.bottom + window.scrollY;
    if (docRight <= 0 || docBottom <= 0) return false;

    return true;
  }

  function isFillable(el) {
    if (el.disabled || el.readOnly) return false;

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' && SKIP_TYPES.has((el.type || 'text').toLowerCase())) return false;

    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') return false;
    if (!isReachable(el, style)) return false;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;

    // Collapsed by clip / clip-path - the "visually hidden" pattern.
    if (style.clipPath === 'inset(50%)' || style.clip === 'rect(0px, 0px, 0px, 0px)') return false;

    return true;
  }

  function candidates() {
    return [...document.querySelectorAll('input, select, textarea')].filter(isFillable);
  }

  // A file input's honeypot signal is narrower than a text field's. Hiding a
  // TEXT field with opacity:0 is a bot trap - nobody styles a real text box
  // that way. Hiding a FILE input with opacity:0 (or clip, or zero size)
  // under a styled <button>/<label> is completely ordinary: it's how nearly
  // every custom "Add File" control works, including the one this feature
  // exists to handle. So this only checks that the input is actually
  // reachable in the page's layout, not that it looks a particular way.
  function isFillableDoc(el) {
    if (el.disabled) return false;
    if (el.tagName.toLowerCase() !== 'input' || (el.type || '').toLowerCase() !== 'file') return false;
    if (el.multiple) return false;                        // one document per slot, for now
    if (el.files && el.files.length > 0) return false;     // never overwrite a file already picked

    return isReachable(el, getComputedStyle(el));
  }

  function fileCandidates() {
    return [...document.querySelectorAll('input[type=file]')].filter(isFillableDoc);
  }

  // ==========================================================================
  // Radio groups
  // ==========================================================================
  //
  // Indian portal forms are dense with these - Gender, Category, Domicile,
  // Marital status - and until now every one of them counted towards "Y" and
  // was never filled, so a form of nineteen fields reported "filled 6 of 19"
  // and read as broken even when the six were right.
  //
  // A radio group is safe to fill in a way a checkbox is not: see the note in
  // SKIP_TYPES. Picking one of "Male / Female / Other" states a fact about the
  // user. Ticking a box marked "I hereby declare the above to be true" makes an
  // assertion on their behalf, and FormPilot does not do that.
  //
  // Visibility is judged like a file input's, not like a text field's: a custom
  // radio UI routinely hides the real <input> under a styled <label>, so only
  // actual unreachability disqualifies one.

  /** Radios sharing a name within the same form are one group. */
  function radioGroups() {
    const byForm = new Map();

    for (const el of document.querySelectorAll('input[type=radio]')) {
      if (!el.name || el.disabled) continue;
      if (!isReachable(el, getComputedStyle(el))) continue;

      // The same name in two different forms is two different questions.
      const form = el.form ?? null;
      if (!byForm.has(form)) byForm.set(form, new Map());
      const byName = byForm.get(form);
      if (!byName.has(el.name)) byName.set(el.name, []);
      byName.get(el.name).push(el);
    }

    const groups = [];
    for (const byName of byForm.values()) groups.push(...byName.values());
    return groups;
  }

  /**
   * The question a group is asking, as one searchable string.
   *
   * Deliberately NOT the fieldset's textContent - that would sweep up every
   * option label ("gender male female other") and match on the answers instead
   * of the question. Only the legend, the name, and explicit ARIA labelling.
   */
  function describeGroup(els) {
    const first = els[0];
    const parts = [first.name];

    const fieldset = first.closest('fieldset');
    if (fieldset) parts.push(fieldset.querySelector('legend')?.textContent);

    const group = first.closest('[role="radiogroup"]');
    if (group) {
      parts.push(group.getAttribute('aria-label'));
      const labelledBy = group.getAttribute('aria-labelledby');
      if (labelledBy) {
        for (const id of labelledBy.split(/\s+/)) {
          parts.push(document.getElementById(id)?.textContent);
        }
      }
    }

    return M.normalise(parts.filter(Boolean).map((part) => String(part).slice(0, 200)).join(' ').slice(0, 600));
  }

  /** One radio's own label, which is what the vault value is matched against. */
  function radioOption(el) {
    const label = el.labels?.[0]?.textContent ?? el.closest('label')?.textContent ?? '';
    return { value: el.value, text: String(label).trim().slice(0, 200) };
  }

  function setNativeChecked(el) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
    if (setter) setter.call(el, true);
    else el.checked = true;
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

  // Option matching lives in lib/match.js so a <select> and a radio group can
  // never disagree about what "Male" or "OBC" resolves to. It also fixed a real
  // bug this function used to have: its loose pass was a substring test, and
  // 'female'.includes('male') is true.
  function fillSelect(el, value) {
    const options = [...el.options].map((option) => ({
      value: option.value,
      text: option.textContent
    }));
    const index = M.chooseOption(value, options);
    if (index < 0) return false;
    setNativeValue(el, el.options[index].value);
    return true;
  }

  function fillOne(el, value) {
    if (el.tagName.toLowerCase() === 'select') return fillSelect(el, value);

    const text = /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(value, el) : String(value);
    setNativeValue(el, text);
    return true;
  }

  // ==========================================================================
  // Document (file-upload) filling
  // ==========================================================================

  /**
   * Work out which file inputs WOULD be filled and with which document type,
   * without ever touching the page or being handed image bytes. `docKeys` is
   * the set of document types the vault holds an image for - `aadhaar`,
   * `pan`, `signature` and so on - never the image itself. Mirrors planFill()
   * for the same reason: a suggestion must never promise a fill it can't
   * deliver, and detection must never need real data to make that promise.
   */
  function planDocFill({ docKeys, docMimes = {} }) {
    const available = safeKeys(docKeys);
    const dictionary = M.buildDocDictionary();
    const plan = [];

    for (const el of fileCandidates()) {
      const guess = M.inferKey(M.describeField(el), dictionary);
      if (!guess || !available.has(guess.key)) continue;
      if (!M.acceptsMime(el.getAttribute('accept'), docMimes[guess.key])) continue;
      plan.push({ el, type: guess.key });
    }
    return plan;
  }

  /**
   * Decode a stored document's data: URL into a File, WITHOUT fetch() - every
   * first-party file is grepped for that with no exceptions (see
   * test/audit.test.mjs), and options.js only ever writes base64 data: URLs
   * here, so a manual decode is one line longer and keeps that invariant
   * genuinely true rather than technically true.
   */
  function dataUrlToFile(dataUrl, name, mime) {
    const comma = String(dataUrl ?? '').indexOf(',');
    if (comma === -1) return null;

    const meta = dataUrl.slice(5, comma);   // e.g. "image/jpeg;base64"
    if (!/;base64$/i.test(meta)) return null;

    let binary;
    try {
      binary = atob(dataUrl.slice(comma + 1));
    } catch {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return new File([bytes], name || 'document', { type: mime || meta.split(';')[0] || 'application/octet-stream' });
  }

  /** Attach one stored document to one file input via a DataTransfer - the
   * only script-driven way to populate input.files. */
  function fillFileInput(el, doc) {
    const file = dataUrlToFile(doc.dataUrl, doc.name, doc.mime);
    if (!file) return false;

    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
    } catch {
      return false;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  /**
   * Work out what WOULD be filled, without touching the page and WITHOUT ever
   * being told a value. `keys` is the set of vault keys that hold something -
   * names like `email` or `custom:Employee ID`, never the data behind them.
   *
   * Shared by the fill itself and by detection, so a suggestion can never
   * promise a number the fill then fails to deliver.
   */
  function planFill({ keys, customFields = [], emails = [], mappings = {} }) {
    const available = safeKeys(keys);
    const dictionary = M.buildDictionary(customFields, emails);
    const all = candidates();

    // Per-site mappings the user taught us win over every guess.
    const taught = new Map();
    for (const [selector, key] of safeMappings(mappings)) {
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

      // A choice-only key needs a control with a fixed set of options, so that
      // a bad guess is harmless - the value either matches an option or nothing
      // happens. "OBC" typed into a free-text "Job Category" box is neither.
      if (M.CHOICE_ONLY.has(key) && el.tagName.toLowerCase() !== 'select') {
        skipped.noMatch++;
        continue;
      }

      // The vault has nothing under that key, so there is nothing to ask for.
      if (!available.has(key)) { skipped.noValue++; continue; }

      // Never overwrite something already in the box.
      if (el.value && el.value.trim() !== '') { skipped.alreadyFilled++; continue; }

      plan.push({
        el, key,
        source: taught.has(el) ? 'taught' : (M.fromAutocomplete(el) ? 'autocomplete' : 'guess')
      });
    }

    // "Y" is the number of fields we could plausibly have filled: everything
    // visible and fillable, minus the ones we had no vault value for.
    const total = Math.max(all.length - skipped.noValue, plan.length);
    return { plan, skipped, total };
  }

  /**
   * Which radio groups could be answered from the vault.
   *
   * WHICH radio to check cannot be decided here, because it depends on the
   * value - and a plan runs before any value has crossed into this page. So the
   * plan names the group and the key it needs; resolving that to one option
   * happens at fill time, locally, once the value is in hand. The two-pass
   * split survives intact.
   */
  function planRadioFill({ keys, customFields = [], emails = [] }) {
    const available = safeKeys(keys);
    const dictionary = M.buildDictionary(customFields, emails);
    const plan = [];

    for (const els of radioGroups()) {
      if (els.some((el) => el.checked)) continue;       // already answered
      const key = M.inferKey(describeGroup(els), dictionary)?.key ?? null;
      if (!key || !available.has(key)) continue;
      plan.push({ els, key });
    }
    return plan;
  }

  /** The plan as a message: a count and the key/type names needed, no elements. */
  function describePlan(message) {
    const { plan, skipped, total } = planFill(message);
    const radioPlan = planRadioFill(message);

    const keys = [...new Set([
      ...plan.map((item) => item.key),
      ...radioPlan.map((item) => item.key)
    ])].slice(0, MAX_FILL_KEYS);

    const docPlan = planDocFill(message);
    const docTypes = [...new Set(docPlan.map((item) => item.type))].slice(0, MAX_FILL_DOC_TYPES);

    return {
      count: plan.length + radioPlan.length,
      keys,
      total: total + radioPlan.length,
      skipped,
      docCount: docPlan.length,
      docTypes
    };
  }

  /**
   * Fill from `values`/`docs`, which hold ONLY the keys/types a preceding PLAN
   * asked for. Both plans are recomputed here rather than trusted from before,
   * so a page that changed in between cannot get something written somewhere
   * it was not planned.
   */
  function fillForm(message) {
    clearOutlines();

    const values = (message.values && typeof message.values === 'object') ? message.values : {};
    const { plan, skipped, total } = planFill({ ...message, keys: Object.keys(values) });
    const highlight = message.highlight !== false;
    const filled = [];

    for (const { el, key, source } of plan) {
      const value = values[key];
      if (value === undefined || value === null || value === '') continue;
      if (!fillOne(el, String(value))) continue;
      announce(el);
      filled.push({ key, source });
      if (highlight) outline(el);
    }

    // Radio groups ride the same keys/values channel as text, because they
    // answer the same vault keys - no extra message field, nothing more crossing
    // into the page than a fill already carried.
    const radioPlan = planRadioFill({ ...message, keys: Object.keys(values) });
    let radioTotal = radioPlan.length;

    for (const { els, key } of radioPlan) {
      const value = values[key];
      if (value === undefined || value === null || value === '') continue;

      const index = M.chooseOption(value, els.map(radioOption));
      if (index < 0) continue;                 // no option means what we hold

      setNativeChecked(els[index]);
      announce(els[index]);
      filled.push({ key, source: 'radio' });
      if (highlight) outline(els[index]);
    }

    const docs = (message.docs && typeof message.docs === 'object') ? message.docs : {};
    const docPlan = planDocFill({ ...message, docKeys: Object.keys(docs) });
    let filledDocs = 0;

    for (const { el, type } of docPlan) {
      const doc = docs[type];
      if (!doc?.dataUrl) continue;
      if (!fillFileInput(el, doc)) continue;
      filledDocs++;
      if (highlight) outline(el);
    }

    const grandTotal = total + radioTotal;
    showToast(filled.length, grandTotal, skipped, filledDocs);
    return { filled: filled.length, total: grandTotal, skipped, details: filled, filledDocs };
  }

  // ==========================================================================
  // Detection: notice a fillable form and offer, rather than waiting to be asked
  // ==========================================================================

  let suggestionDismissed = false;
  let pendingMeta = null;      // key names + labels only. Never values.

  /**
   * Count what could be filled and, if anything can, show the suggestion chip.
   * Returns the count so the service worker can badge the toolbar icon.
   *
   * `message` carries no vault values, and neither does anything this stores.
   */
  function detect(message) {
    pendingMeta = message;
    const { plan } = planFill(message);
    const docPlan = planDocFill(message);
    const total = plan.length + docPlan.length;

    if (total > 0) {
      if (message.showChip !== false) showSuggestion(total);
    } else {
      // Nothing yet. Forms rendered late by a framework are the common case, so
      // re-check once the user actually touches a field rather than giving up.
      armLateDetect();
    }
    return { count: total };
  }

  function armLateDetect() {
    if (suggestionDismissed) return;
    document.addEventListener('focusin', onLateFocus, true);
  }

  function onLateFocus(event) {
    if (suggestionDismissed || !pendingMeta) return;
    const el = event.target;
    if (!(el instanceof Element) || !el.matches('input, select, textarea, input[type=file]')) return;

    const { plan } = planFill(pendingMeta);
    const docPlan = planDocFill(pendingMeta);
    const total = plan.length + docPlan.length;
    if (total === 0) return;

    document.removeEventListener('focusin', onLateFocus, true);
    if (pendingMeta.showChip !== false) showSuggestion(total);
  }

  /**
   * The chip's Fill button. This is the moment values are allowed into the page,
   * so it is the moment everything is checked: a real click, and then the
   * service worker hands back only the keys/types this plan needs.
   */
  async function fillFromChip(event) {
    // A page cannot forge this. element.click() and dispatchEvent() both produce
    // isTrusted:false, so a script that reached our button still cannot fire it.
    if (!event.isTrusted || !pendingMeta) return;

    const { keys, docTypes } = describePlan(pendingMeta);
    if (keys.length === 0 && docTypes.length === 0) return;

    const reply = await chrome.runtime.sendMessage({ type: 'REQUEST_FILL', keys, docTypes }).catch(() => null);
    if (!reply?.ok) {
      showMessage('FormPilot', reply?.error ?? 'The vault is locked.');
      return;
    }
    fillForm({ ...pendingMeta, values: reply.values, docs: reply.docs, highlight: reply.highlight });
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
    fill.addEventListener('click', fillFromChip);

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
    // Held in a module variable rather than looked up from the DOM: with a
    // closed shadow root, host.shadowRoot is null for everyone, us included.
    if (uiShadow && uiShadow.isConnected) return uiShadow;

    const host = document.createElement('div');
    host.id = UI_HOST_ID;
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('inset', 'auto 16px 16px auto', 'important');

    // closed: the page cannot reach into our UI to read it or click its buttons.
    const shadow = host.attachShadow({ mode: 'closed' });
    uiShadow = shadow;

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
    uiShadow?.host?.remove();
    uiShadow = null;
  }

  /** One card, two lines of text. Every caller builds nodes, never markup. */
  function showMessage(heading, detail) {
    const shadow = uiRoot();
    const slot = shadow.getElementById('slot');
    slot.replaceChildren();

    const card = document.createElement('div');
    card.className = 'card';
    const title = document.createElement('strong');
    title.textContent = heading;
    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = detail;
    card.append(title, note);
    slot.append(card);
    return card;
  }

  function showToast(filled, total, skipped, filledDocs = 0) {
    const extra = skipped.alreadyFilled
      ? ` ${skipped.alreadyFilled} already had a value.`
      : '';
    const docNote = filledDocs > 0
      ? ` +${filledDocs} document${filledDocs === 1 ? '' : 's'} attached.`
      : '';

    showMessage(`FormPilot filled ${filled} of ${total}${docNote}`, `Review before you submit.${extra}`);

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

  // siteMappings is the one thing this script writes to storage, and it is
  // written unencrypted, so it is capped on every axis. Nothing here is
  // personal: a hostname, a CSS selector and a vault field NAME - never a value.
  const MAX_MAPPED_HOSTS = 200;
  const MAX_MAPPINGS_PER_HOST = 100;
  const MAX_SELECTOR_CHARS = 500;

  async function saveMapping(el, key) {
    const host = location.hostname;
    const selector = stableSelector(el);
    if (!host || !selector || selector.length > MAX_SELECTOR_CHARS) return;

    const { siteMappings = {} } = await chrome.storage.local.get('siteMappings');
    const forHost = { ...(siteMappings[host] ?? {}) };

    // Refuse to grow without limit rather than silently evicting something the
    // user taught earlier - a full map is a bug worth noticing, not data to bin.
    if (!(selector in forHost) && Object.keys(forHost).length >= MAX_MAPPINGS_PER_HOST) return;
    if (!(host in siteMappings) && Object.keys(siteMappings).length >= MAX_MAPPED_HOSTS) return;

    forHost[selector] = key;
    siteMappings[host] = forHost;
    await chrome.storage.local.set({ siteMappings });
  }
}
