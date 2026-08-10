// FormPilot - the try-it demo.
//
// The problem this exists to solve: the old first run asked for a passphrase
// that can never be recovered, then for a real name, a real phone number and a
// real Aadhaar - all before showing that any of it works. That is a large ask
// for software you have known for ninety seconds, and it is where people quit.
//
// So this fills a pretend form with pretend details, and asks for nothing.
//
// It is a DEMONSTRATION, NOT A SIMULATION, and the distinction is the whole
// point. The decisions below come from lib/match.js - the same file, unchanged,
// that content.js uses on real pages: the same synonym table, the same NEVER
// and THIRD_PARTY guards, the same specific-beats-generic tie-break. A mock-up
// that faked plausible-looking output would be a lie told to someone deciding
// whether to trust us with their identity documents.
//
// What is deliberately NOT reused is content.js's field scanner. Copying it
// would create a second implementation to keep in step (see the expandValues
// drift guard in test/audit.test.mjs for how that goes), so this page walks its
// own known, fixed set of twenty fields with a minimal scanner. The matching -
// the part that is actually clever - is real.
//
// Reads nothing, writes nothing: no vault, no storage, no messages.

const M = globalThis.FormPilotMatch;

// --- The pretend person -----------------------------------------------------
//
// Obviously fake, and deliberately so: example.com is reserved for exactly this
// (RFC 2606), the PAN is the standard placeholder pattern, and the Aadhaar is
// shown the way the real vault stores one - last four digits only, never more.

const SAMPLE = {
  fields: {
    fullName: 'Aarav Sharma',
    dob: '1999-04-12',
    email: 'aarav.sharma@example.com',
    phone: '9876543210',
    address: '14 MG Road, Shivajinagar',
    city: 'Pune',
    state: 'Maharashtra',
    postcode: '411005',
    pan: 'ABCDE1234F',
    aadhaarMasked: 'XXXX XXXX 8842',
    gender: 'Male',
    category: 'OBC'
  },
  customFields: [],
  emails: []
};

const SAMPLE_LABELS = {
  fullName: 'Full name',
  dob: 'Date of birth',
  email: 'Email',
  phone: 'Mobile',
  address: 'Address',
  city: 'City',
  state: 'State',
  postcode: 'PIN code',
  pan: 'PAN',
  aadhaarMasked: 'Aadhaar (last 4 only)',
  gender: 'Gender',
  category: 'Category'
};

// Input types that are never fillable from a vault. Kept in step with
// content.js's SKIP_TYPES by hand; `password` is the one that matters, and the
// audit checks that one separately in both files.
// Radio and checkbox are excluded here because neither is judged one element at
// a time: a radio belongs to a group, and a checkbox is never filled at all.
const SKIP_TYPES = new Set([
  'submit', 'button', 'reset', 'image', 'hidden', 'file', 'radio', 'checkbox'
]);

// --- Outcomes ---------------------------------------------------------------
//
// Every field gets one of these, and the refusals matter more than the fills.
// Anything can type a name into a box; refusing to put your name in your
// father's field, or your details into a captcha, is the part worth showing.

const OUTCOME = {
  filled:      { tick: '✓', cls: 'tick--yes', why: (k) => `Filled from ${k}.` },
  chosen:      { tick: '✓', cls: 'tick--yes', why: (k) => `Chose the option matching ${k}.` },
  password:    { tick: '—', cls: 'tick--no', why: () => 'Password field. FormPilot never fills one, ever.' },
  already:     { tick: '—', cls: 'tick--no', why: () => 'You had already typed something here. Never overwritten.' },
  thirdParty:  { tick: '—', cls: 'tick--no', why: () => 'Somebody else’s field. Your details do not go here unless you say so.' },
  never:       { tick: '—', cls: 'tick--no', why: () => 'On the never-fill list. A form that asks this wants a human.' },
  declaration: { tick: '—', cls: 'tick--no', why: () => 'A checkbox is a statement you are making. FormPilot never ticks one — that is yours to do, like pressing Submit.' },
  noMatch:     { tick: '—', cls: 'tick--no', why: () => 'Nothing in the vault matches this field.' }
};

// --- Filling ----------------------------------------------------------------

// The same approach content.js uses: React and Vue install their own value
// setter and track changes through it, so assigning el.value directly is
// invisible to them. Nothing on this page is a framework, but doing it the real
// way keeps the demo honest.
function setNativeValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
    HTMLInputElement.prototype;

  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function announce(el) {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function setNativeChecked(el, checked = true) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
  if (setter) setter.call(el, checked);
  else el.checked = checked;
}

function fillSelect(el, value) {
  const want = String(value).trim().toLowerCase();
  for (const option of el.options) {
    if (option.value.toLowerCase() === want || option.textContent.trim().toLowerCase() === want) {
      setNativeValue(el, option.value);
      return true;
    }
  }
  return false;
}

// --- The scan ---------------------------------------------------------------

/**
 * Decide what would happen to one field, and say why in a sentence.
 * @returns {{el: Element, label: string, outcome: string, key: string|null}}
 */
function judge(el, dictionary) {
  const label = fieldLabel(el);
  const type = (el.tagName.toLowerCase() === 'select' ? 'select' : el.type || 'text').toLowerCase();

  if (type === 'password') return { el, label, outcome: 'password', key: null };
  if (el.value) return { el, label, outcome: 'already', key: null };

  const haystack = M.describeField(el);
  const key = M.fromAutocomplete(el) ?? M.inferKey(haystack, dictionary)?.key ?? null;

  if (!key) {
    // Say WHICH rule refused it. inferKey returns null for all three cases and
    // the difference is exactly what a person wants explained.
    if (M.NEVER.test(haystack)) return { el, label, outcome: 'never', key: null };
    if (M.THIRD_PARTY.test(haystack)) return { el, label, outcome: 'thirdParty', key: null };
    return { el, label, outcome: 'noMatch', key: null };
  }
  return { el, label, outcome: 'filled', key };
}

/** The visible label, for the report - not for matching. */
function fieldLabel(el) {
  const text = el.labels?.[0]?.textContent ?? el.name ?? el.id ?? 'this field';
  return String(text).trim().replace(/\s+/g, ' ');
}

function fields() {
  const found = document.querySelectorAll('#portal input, #portal select, #portal textarea');
  return [...found].filter((el) => !SKIP_TYPES.has((el.type || 'text').toLowerCase()));
}

/** Each radio group, as one question — mirroring radioGroups() in content.js. */
function groups() {
  const byName = new Map();
  for (const el of document.querySelectorAll('#portal input[type=radio]')) {
    if (!byName.has(el.name)) byName.set(el.name, []);
    byName.get(el.name).push(el);
  }
  return [...byName.values()];
}

function groupLabel(els) {
  return els[0].closest('fieldset')?.dataset.group ?? els[0].name;
}

/** One radio's own label, which is what the vault value is matched against. */
function radioOption(el) {
  const label = el.closest('label')?.textContent ?? el.value;
  return { value: el.value, text: String(label).trim() };
}

function checkboxes() {
  return [...document.querySelectorAll('#portal input[type=checkbox]')];
}

// --- Rendering --------------------------------------------------------------
//
// textContent and createElement throughout. Extension pages are privileged, so
// building markup out of a string is one interpolation away from an injection -
// even when today's input is a constant in this very file.

function renderSample() {
  const list = document.getElementById('sampleList');
  for (const [key, label] of Object.entries(SAMPLE_LABELS)) {
    const row = document.createElement('div');
    row.className = 'list__row';

    const name = document.createElement('span');
    name.textContent = label;

    const spacer = document.createElement('span');
    spacer.className = 'spacer';

    const value = document.createElement('span');
    value.className = 'tagline';
    value.textContent = SAMPLE.fields[key];

    row.append(name, spacer, value);
    list.append(row);
  }
}

function renderReport(rows) {
  const outcome = document.getElementById('outcome');
  outcome.textContent = '';

  for (const row of rows) {
    const spec = OUTCOME[row.outcome];

    const line = document.createElement('div');
    line.className = 'outcome__row';

    const tick = document.createElement('span');
    tick.className = `tick ${spec.cls}`;
    tick.textContent = spec.tick;

    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = row.label;

    const why = document.createElement('span');
    why.className = 'why';
    why.textContent = spec.why(row.key);

    line.append(tick, what, why);
    outcome.append(line);
  }

  const filled = rows.filter((r) => r.outcome === 'filled' || r.outcome === 'chosen').length;
  const refused = rows.length - filled;

  const badge = document.getElementById('resultBadge');
  badge.textContent = `${filled} of ${rows.length}`;
  badge.classList.add('unlocked');

  document.getElementById('resultLead').textContent =
    `Filled ${filled}. Left ${refused} alone on purpose — and the second number `
    + 'is the one worth reading. Nothing was submitted.';

  document.getElementById('resultView').classList.remove('hidden');
}

// --- Actions ----------------------------------------------------------------

document.getElementById('fillBtn').addEventListener('click', () => {
  const dictionary = M.buildDictionary(SAMPLE.customFields, SAMPLE.emails);
  const values = M.expandValues(SAMPLE.fields, SAMPLE.customFields, SAMPLE.emails);

  const rows = fields().map((el) => judge(el, dictionary));

  // Radio groups: the group is the unit, and the real matcher decides both
  // which question it is and which option answers it.
  for (const els of groups()) {
    const label = groupLabel(els);
    const key = M.inferKey(M.normalise(els[0].name), dictionary)?.key ?? null;
    const value = key ? values[key] : undefined;
    const index = value === undefined ? -1 : M.chooseOption(value, els.map(radioOption));

    if (index < 0) { rows.push({ el: els[0], label, outcome: 'noMatch', key: null }); continue; }

    setNativeChecked(els[index]);
    announce(els[index]);
    els[index].closest('label')?.classList.add('is-filled');
    rows.push({ el: els[index], label, outcome: 'chosen', key });
  }

  // Checkboxes: never, and the reason is the point.
  for (const box of checkboxes()) {
    const label = box.closest('label')?.textContent.trim().slice(0, 46) ?? box.name;
    rows.push({ el: box, label: `${label}…`, outcome: 'declaration', key: null });
  }

  for (const row of rows) {
    if (row.outcome !== 'filled') continue;

    const value = values[row.key];
    if (value === undefined) { row.outcome = 'noMatch'; continue; }

    const done = row.el.tagName.toLowerCase() === 'select'
      ? fillSelect(row.el, value)
      : (setNativeValue(row.el, value), true);

    if (done) {
      announce(row.el);
      row.el.classList.add('is-filled');
    } else {
      row.outcome = 'noMatch';
    }
  }

  renderReport(rows);
  document.getElementById('resultView').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('resetBtn').addEventListener('click', () => {
  for (const el of fields()) {
    if (el.id === 'altemail') continue;      // the pre-filled one stays pre-filled
    setNativeValue(el, '');
    el.classList.remove('is-filled');
  }
  for (const el of document.querySelectorAll('#portal input[type=radio], #portal input[type=checkbox]')) {
    setNativeChecked(el, false);
    el.closest('label')?.classList.remove('is-filled');
  }
  document.getElementById('resultView').classList.add('hidden');
});

document.getElementById('setupBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Boot -------------------------------------------------------------------

async function applyGlassMode() {
  let mode = 'tinted';
  try {
    const { settings } = await chrome.storage.local.get('settings');
    mode = settings?.glassMode ?? 'tinted';
  } catch { /* first run, before any settings exist */ }
  document.documentElement.classList.toggle('lg-clear', mode === 'clear');
  document.documentElement.classList.toggle('lg-tinted', mode !== 'clear');
}

renderSample();
applyGlassMode();
