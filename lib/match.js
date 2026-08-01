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

  // Extra email addresses are stored under a fixed set of labels, so each one
  // gets real synonyms rather than relying on whatever the user typed.
  const EMAIL_LABEL_SYNONYMS = {
    personal:  ['personal email', 'personal e mail', 'private email'],
    work:      ['work email', 'office email', 'official email', 'company email',
                'business email', 'employer email'],
    college:   ['college email', 'institute email', 'university email',
                'student email', 'academic email', 'campus email'],
    alternate: ['alternate email', 'alternative email', 'secondary email',
                'second email', 'other email', 'backup email'],
    guardian:  ['parent email', 'parents email', 'guardian email',
                'father email', 'mother email'],
    other:     []   // no synonyms — only reachable by teaching a mapping
  };

  // Fields we refuse to touch even when a synonym matches. "username" contains
  // "name"; "company name" is not the user's name; OTP/captcha must be typed by
  // a human or the fill is actively harmful.
  const NEVER = /\b(user\s?name|login\s?id|company|organi[sz]ation|employer|captcha|otp|one\s?time|verification\s?code|search|coupon|promo|password|confirm)\b/;

  // Fields that belong to SOMEBODY ELSE. "Father's Name" matches the `fullName`
  // synonym "name", so without this guard the user's own name gets filled into
  // their father's field — and their own address into "Parent Email".
  //
  // These are not banned outright: a value the user explicitly labelled for that
  // person (an email tagged "Parent / Guardian", or a taught per-site mapping)
  // still fills them. Only generic, guessed matches are refused.
  const THIRD_PARTY = /\b(parent|parents|guardian|father|mother|spouse|husband|wife|nominee|emergency|next\s?of\s?kin|reference|referee|witness)\b/;

  // --- Text helpers ---------------------------------------------------------

  // Squash anything that is not a letter or digit into single spaces, so
  // "first_name", "firstName" and "First Name:" all normalise the same way.
  function normalise(text) {
    return String(text ?? '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')   // firstName -> first Name
      .toLowerCase()
      // Drop the possessive before punctuation is squashed, or "Father's Email"
      // becomes "father s email" and stops matching "father email".
      .replace(/['’]s\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function containsPhrase(haystack, phrase) {
    // Word-boundary match so "pan" does not match "company" or "panel".
    return new RegExp(`(^| )${phrase.replace(/ /g, ' ')}( |$)`).test(haystack);
  }

  // --- Building the dictionary ---------------------------------------------

  /**
   * Base synonyms, plus one entry per extra email address, plus one per custom
   * vault field. A custom field labelled "Passport no." becomes matchable.
   *
   * `priority` breaks ties before length does. Without it a field labelled
   * "Work Email Address" would resolve to the primary `email`, because
   * "email address" (13 chars) is longer than "work email" (10) — the more
   * specific answer would lose to the more generic one.
   */
  function buildDictionary(customFields = [], emails = []) {
    const entries = Object.entries(SYNONYMS)
      .map(([key, synonyms]) => ({ key, synonyms, priority: 0 }));

    for (const email of emails) {
      if (!email?.label || !email?.value) continue;
      const synonyms = [...(EMAIL_LABEL_SYNONYMS[email.label] ?? [])];
      if (synonyms.length === 0) continue;
      entries.push({ key: `email:${email.label}`, synonyms, priority: 1 });
    }

    for (const field of customFields) {
      const label = normalise(field.label);
      if (label) entries.push({ key: `custom:${field.label}`, synonyms: [label], priority: 1 });
    }
    return entries;
  }

  /**
   * Expand the stored vault fields into everything a form might ask for.
   * fullName "Dishan Jadhav" also answers firstName and lastName.
   */
  function expandValues(fields = {}, customFields = [], emails = []) {
    const values = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value) values[key] = value;
    }

    // Extra addresses answer their own labelled key, and the first one also
    // answers a bare "alternate email" field.
    for (const email of emails) {
      if (!email?.label || !email?.value) continue;
      values[`email:${email.label}`] = email.value;
      values['email:alternate'] ??= email.value;
    }
    // If no primary was set, the first extra becomes the fallback answer.
    if (!values.email && emails.length) values.email = emails[0]?.value ?? '';

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

    // Somebody else's field: accept only values the user labelled for them, or
    // taught for this site. Never a generic guess about the user's own details.
    const minimumPriority = THIRD_PARTY.test(haystack) ? 1 : 0;

    let best = null;
    for (const { key, synonyms, priority = 0 } of dictionary) {
      if (priority < minimumPriority) continue;
      for (const phrase of synonyms) {
        if (!containsPhrase(haystack, phrase)) continue;
        // Priority first (a taught or qualified key beats a generic one), then
        // length: "first name" beats "name".
        const better = !best
          || priority > best.priority
          || (priority === best.priority && phrase.length > best.matched.length);
        if (better) best = { key, matched: phrase, priority };
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
    AUTOCOMPLETE_MAP, SYNONYMS, NEVER, THIRD_PARTY, EMAIL_LABEL_SYNONYMS,
    normalise, buildDictionary, expandValues, inferKey, describeField, fromAutocomplete
  };
})();
