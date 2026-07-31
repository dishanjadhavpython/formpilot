// FormPilot - field matching
//
// Loaded as a classic script into the content script's isolated world, so it
// publishes one global instead of using ES module syntax. The guard makes
// re-injection harmless (the popup injects on every click).
//
// MATCH ORDER, most reliable first:
//   1. A per-site mapping the user taught us       (exact, wins outright)
//   2. The `autocomplete` attribute                (a web standard; trust it)
//   3. name / id / label / placeholder / aria-label against the synonyms below
//
// Step 3 is a guess, so it scores by the LENGTH of the matched synonym: a field
// labelled "First name" matches both `firstName` ("first name", 10 chars) and
// `fullName` ("name", 4 chars), and the longer, more specific match wins.

globalThis.FormPilotMatch = globalThis.FormPilotMatch || (() => {
  'use strict';

  // --- Standard autocomplete tokens -> our vault keys ------------------------
  // https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
  const AUTOCOMPLETE_MAP = {
    'name': 'fullName',
    'given-name': 'firstName',
    'additional-name': 'middleName',
    'family-name': 'lastName',
    'email': 'email',
    'tel': 'phone',
    'tel-national': 'phone',
    'mobile': 'phone',
    'bday': 'dob',
    'street-address': 'address',
    'address-line1': 'address',
    'address-level2': 'city',
    'address-level1': 'state',
    'postal-code': 'postcode',
    'country-name': 'country'
  };

  // --- Synonyms for the guessing pass ---------------------------------------
  // Extend freely: every entry is matched on word boundaries, so adding a short
  // token here is the usual cause of a bad match. Prefer specific phrasings.
  const SYNONYMS = {
    firstName:     ['first name', 'firstname', 'given name', 'fname', 'first'],
    middleName:    ['middle name', 'middlename', 'mname'],
    lastName:      ['last name', 'lastname', 'surname', 'family name', 'lname'],
    fullName:      ['full name', 'fullname', 'your name', 'applicant name',
                    'candidate name', 'student name', 'name of applicant', 'name'],
    dob:           ['date of birth', 'dateofbirth', 'birth date', 'birthdate',
                    'birthday', 'dob', 'd o b'],
    email:         ['email address', 'e mail address', 'email id', 'emailid',
                    'email', 'e mail'],
    phone:         ['mobile number', 'phone number', 'contact number',
                    'contact no', 'mobile no', 'phone no', 'telephone',
                    'mobile', 'phone', 'contact', 'tel'],
    address:       ['permanent address', 'residential address', 'street address',
                    'full address', 'address line', 'address', 'addr'],
    city:          ['city', 'town', 'district'],
    state:         ['state', 'province', 'region'],
    postcode:      ['postal code', 'postcode', 'pin code', 'pincode', 'zip code', 'zip'],
    country:       ['country', 'nationality'],
    pan:           ['permanent account number', 'pan number', 'pan card', 'pan no', 'pan'],
    aadhaarMasked: ['aadhaar number', 'aadhar number', 'aadhaar no', 'aadhaar',
                    'aadhar', 'uidai', 'uid']
  };

  // Fields we refuse to touch even when a synonym matches. "username" contains
  // "name"; "company name" is not the user's name; OTP/captcha must be typed by
  // a human or the fill is actively harmful.
  const NEVER = /\b(user\s?name|login\s?id|company|organi[sz]ation|employer|captcha|otp|one\s?time|verification\s?code|search|coupon|promo|password|confirm)\b/;

  // --- Text helpers ---------------------------------------------------------

  // Squash anything that is not a letter or digit into single spaces, so
  // "first_name", "firstName" and "First Name:" all normalise the same way.
  function normalise(text) {
    return String(text ?? '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')   // firstName -> first Name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function containsPhrase(haystack, phrase) {
    // Word-boundary match so "pan" does not match "company" or "panel".
    return new RegExp(`(^| )${phrase.replace(/ /g, ' ')}( |$)`).test(haystack);
  }

  // --- Building the dictionary ---------------------------------------------

  /**
   * Base synonyms plus one entry per custom vault field, keyed by its label.
   * A custom field labelled "Passport no." becomes a matchable key.
   */
  function buildDictionary(customFields = []) {
    const entries = Object.entries(SYNONYMS).map(([key, synonyms]) => ({ key, synonyms }));

    for (const field of customFields) {
      const label = normalise(field.label);
      if (label) entries.push({ key: `custom:${field.label}`, synonyms: [label] });
    }
    return entries;
  }

  /**
   * Expand the stored vault fields into everything a form might ask for.
   * fullName "Dishan Jadhav" also answers firstName and lastName.
   */
  function expandValues(fields = {}, customFields = []) {
    const values = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value) values[key] = value;
    }

    const full = (fields.fullName ?? '').trim();
    if (full) {
      const parts = full.split(/\s+/);
      if (parts.length > 1) {
        values.firstName ??= parts[0];
        values.lastName ??= parts[parts.length - 1];
        if (parts.length > 2) values.middleName ??= parts.slice(1, -1).join(' ');
      } else {
        values.firstName ??= full;
      }
    }

    for (const field of customFields) {
      if (field.label && field.value) values[`custom:${field.label}`] = field.value;
    }
    return values;
  }

  // --- The guess ------------------------------------------------------------

  /**
   * @param {string} haystack  normalised text describing one form field
   * @param {Array}  dictionary from buildDictionary()
   * @returns {{key: string, matched: string}|null}
   */
  function inferKey(haystack, dictionary) {
    if (!haystack || NEVER.test(haystack)) return null;

    let best = null;
    for (const { key, synonyms } of dictionary) {
      for (const phrase of synonyms) {
        if (!containsPhrase(haystack, phrase)) continue;
        // Longer synonym = more specific = better. "first name" beats "name".
        if (!best || phrase.length > best.matched.length) {
          best = { key, matched: phrase };
        }
      }
    }
    return best;
  }

  /** Everything we know about a field, flattened into one searchable string. */
  function describeField(el) {
    const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.title];

    // <label for=...> and wrapping <label>
    if (el.labels) for (const label of el.labels) parts.push(label.textContent);
    const wrapping = el.closest('label');
    if (wrapping) parts.push(wrapping.textContent);

    // aria-labelledby can point at arbitrary nodes
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        parts.push(document.getElementById(id)?.textContent);
      }
    }
    return normalise(parts.filter(Boolean).join(' '));
  }

  /** The autocomplete attribute, stripped of its optional section/billing prefix. */
  function fromAutocomplete(el) {
    const raw = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
    if (!raw || raw === 'off' || raw === 'on') return null;
    const token = raw.split(/\s+/).pop();      // "billing street-address" -> "street-address"
    return AUTOCOMPLETE_MAP[token] ?? null;
  }

  return {
    AUTOCOMPLETE_MAP, SYNONYMS, NEVER,
    normalise, buildDictionary, expandValues, inferKey, describeField, fromAutocomplete
  };
})();
