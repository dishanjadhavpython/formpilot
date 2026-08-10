# FormPilot — project rules

A local-first Chrome/Edge extension (Manifest V3): encrypted document vault +
intelligent form autofill + resize-to-portal-spec + OCR extract. No backend, no
accounts, works offline. Built in phases — see [PLAN.md](PLAN.md).

**Follow [DESIGN.md](DESIGN.md) for all UI. Apply it during every phase.** Every
visual value lives in `styles/one-ui.css` as a custom property — never hard-code
a colour, radius, spacing, type step, shadow or duration anywhere else. Read its
"As built" section before touching the CSS: several class names are written by
JavaScript at runtime and cannot be renamed.

## Hard rules

These are not preferences. Breaking one is a bug, even if the feature works.

1. **Never auto-submit a form.** No `form.submit()`, no `.click()` on submit
   buttons, no Enter-key synthesis. The user reviews and submits, always.

1a. **Never tick a checkbox.** Same principle as rule 1, and it is not a
   limitation waiting to be lifted. A checkbox on the forms this extension
   exists for is overwhelmingly a *statement the user is making* — "I hereby
   declare the above to be true", "I accept the terms", "I consent to receive".
   Ticking one asserts it on their behalf, which is the same category of act as
   pressing Submit for them. The few checkboxes carrying mere facts are not
   worth the ones that do not. `checkbox` stays in `SKIP_TYPES` in `content.js`,
   and `npm run audit` fails if it leaves.

   **Radio groups are different and *are* filled.** Choosing one of "Male /
   Female / Other" states a fact; it asserts nothing the user has not already
   told the vault. See "Choice fields" below.
2. **Never write plaintext personal data to disk.** Anything personal reaches
   `chrome.storage.local` only via `encryptVault()` in `lib/crypto.js`. Exactly
   three unencrypted keys exist, and adding a fourth needs a good reason:
   - `session.vaultData` — decrypted text fields while unlocked, so the popup
     can fill forms. `chrome.storage.session` is **memory-only, never written to
     disk**, and pinned to `TRUSTED_CONTEXTS` so content scripts cannot read it.
     Cleared on Lock and on browser restart. Since Phase 6, this also carries
     one document per type (most recently added), so a `FILL` can attach a
     stored Aadhaar/PAN/signature image to a matching `input[type=file]` —
     `options.js`'s `publishSession()` falls back to publishing text only if
     that pushes the session store over its own ~10MB quota.
   - `local.settings` — UI preferences. No personal data.
   - `local.siteMappings` — `hostname → { cssSelector: vaultFieldName }`. Field
     *names*, never values. Unencrypted because the popup must read it while the
     vault may be locked; the hostnames it reveals are already in your browser
     history.
3. **Never fill password fields.** Skip `input[type=password]` in autofill.
   Likewise never put the user's own details into somebody else's field —
   "Father's Name", "Spouse Email", "Nominee", "Emergency Contact". `THIRD_PARTY`
   in `lib/match.js` restricts those to explicitly labelled or taught values.

3a. **A web page is told what the vault can answer, never what the answer is.**
   The content script lives inside somebody else's page, so treat every value
   that reaches it as spent. `DETECT` and `PLAN` carry **key names and labels
   only** — `describeVault()` in `lib/match.js` and `publicMeta()` in
   `background.js` produce them, and neither can return a value. The same
   applies to documents: `DETECT`/`PLAN` carry only a document's *type* and
   *mime* (`describeDocs()`, `docKeys`/`docMimes`), never its image data. Real
   values and images cross only in a `FILL`, only for the keys/types that fill
   is about to write, and only after a trusted click. Putting `fields:` or a
   `dataUrl:` back on a `DETECT` message turns ordinary browsing into
   broadcasting; `npm run audit` fails if you do.
4. **No network. Ever.** No `fetch`, no CDN, no analytics, no telemetry. If a
   feature seems to need the network, it is the wrong feature.
5. **No remote code (MV3 requirement).** Third-party libraries get vendored into
   `/vendor` and referenced by local path. Set `corePath`/`workerPath`/`langPath`
   at local files. **Vendoring a file is not sufficient** — audit what the
   library does at runtime. `browser-image-compression`'s default export fetches
   itself from a CDN inside a blob-URL worker unless `useWebWorker: false`;
   `tesseract.js` will do the same with its core and traineddata. Grep any new
   dependency for `importScripts`, `createObjectURL`, `new Worker` and `http`
   before trusting it, and record findings in `vendor/README.md`.
6. **Vanilla JS + HTML + CSS.** No frameworks, no bundler, no build step, no
   runtime npm dependencies. It must load unpacked exactly as it sits on disk.

## Crypto invariants

- PBKDF2-SHA256 → AES-256-GCM. Parameters live in `lib/crypto.js`.
- **A fresh random IV on every single save.** Reusing an IV under one key breaks
  GCM outright. `encryptVault()` generates one per call — never pass one in.
- The salt is per-vault, random, and stored in the clear. It is fixed for the
  life of a **passphrase**: never regenerated on an ordinary save (the old
  ciphertext would stop opening), and regenerated exactly once per
  `changePassphrase()`, where everything is being re-encrypted anyway and
  separate salts stop one PBKDF2 run testing a candidate against both an old
  backup and the new record.
- **A passphrase change verifies before it writes.** `changePassphrase()`
  decrypts the record it just produced, with the new key, before returning it.
  A half-applied change is an unopenable vault — worse than no change.
- Derived keys are `extractable: false` and live only in page memory. They are
  never written to storage, never logged, never passed in messages.
- No stored password hash — a failed decrypt *is* the wrong-passphrase signal.
- Store the minimum: Aadhaar is reduced to its last 4 digits *before* it reaches
  the vault object, not at display time.
- **Locking means locking.** `lockLocally()` must clear every trace derived from
  a document — OCR text, image Blobs, object URLs, preview `src`, file inputs —
  not just the key. Anything new that touches document data belongs in it.

## Platform gotchas

- **The service worker is ephemeral.** It sleeps and wipes its globals. Keep
  state in `chrome.storage`, not module-level variables in `background.js`.
  Anything that must survive the worker sleeping (the auto-lock countdown) goes
  through `chrome.alarms`.
- **Contexts cannot call each other.** Popup, options, content script and worker
  talk via `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.
- **After setting a field's value, dispatch `input` and `change`** or React/Vue
  sites ignore the fill.
- **No inline `<script>`** — MV3 CSP forbids it. External files only. The
  extension CSP additionally carries `'wasm-unsafe-eval'`, required for the OCR
  engine's WebAssembly; it does not permit `eval()` or remote code.
- **Never `innerHTML` with vault data.** Extension pages are privileged; use
  `textContent` and `createElement`.
- `chrome.storage.local` is ~10 MB. Images are the only thing that will ever
  threaten that.

## Proactive detection

`background.js` scans a page on load and badges the toolbar with how many fields
it could fill. This is the one place the extension scripts a page the user did
not explicitly ask about, so it is gated four ways and **all four must hold**:

1. the optional `<all_urls>` host permission is **granted** — see below;
2. the page is `http(s)` — never `chrome://`, never the Web Store;
3. the vault is **unlocked** — a locked vault means zero page scripting;
4. the `suggestFills` setting is on.

Detection counts and offers. It never fills — `DETECT` calls `planFill()`, which
touches nothing. Filling is always one explicit click, from the popup or the
inline chip.

**`<all_urls>` is optional, and must stay that way.** It lives in
`optional_host_permissions`, not `host_permissions`, so a fresh install carries
no standing access to any site and the install prompt never says "read and
change all your data on all websites". Filling on click needs none of it —
`activeTab` grants access to the one tab whose toolbar icon was clicked.
`options.js` requests the permission from the `suggestFills` toggle (inside the
change event: `chrome.permissions.request()` needs a live user gesture, and an
`await` in a save handler has already spent it) and hands it back when the
toggle goes off. Both `detectForms()` and `releaseFill()` re-check the grant
live via `hasBroadHostAccess()` — it can be revoked from `chrome://extensions`
without the worker ever being told, so a cached answer is a stale one. Never
store `suggestFills: true` without the permission actually held; the two drift,
and `background.js` reads the stored value.

## OCR

- Recognition is on-device and must stay that way. `lib/ocr.js` overrides
  `workerPath`, `corePath` and `langPath`, and sets `workerBlobURL: false`.
  Losing any one of those silently reintroduces a CDN fetch.
- OCR output is a *suggestion*, never a save. It lands in the visible form for
  review; only "Save vault" encrypts it.
- Aadhaar is masked to its last four digits inside the extractor, before the
  value is ever returned.

## Layout

```
manifest.json     background.js (service worker)
popup.html/js     options.html/js   (vault + image tool + OCR)
welcome.html/js   (first run; opened once on install)
demo.html/js      (try-it sample form; no vault, no storage)
content.js        (field detection + fill; injected programmatically, never declared)
lib/              crypto.js, match.js, image.js, ocr.js, backup.js
vendor/           third-party libs, local copies only
tools/            dev scripts, not shipped
icons/
```

## Choice fields

Radio groups and `<select>`s are filled through one shared path, and both
safety properties come from the same place.

- **The group is the unit, never the individual radio.** `radioGroups()` in
  `content.js` buckets by `name` *within a form* — the same name in two forms is
  two different questions. A group with any radio already checked is left alone.
- **`describeGroup()` reads the question, never the answers.** The `name`, the
  `<legend>`, and explicit ARIA labelling only. Using the fieldset's
  `textContent` would sweep up every option label ("gender male female other")
  and match on the answers.
- **A value must match an offered option or nothing happens.** `chooseOption()`
  in `lib/match.js` is the single matcher for both radios and `<select>`s, so
  the two can never disagree about what "Male" or "OBC" resolves to. This is
  what makes a *wrong* guess about which question a group asks harmless.
- **Its loose pass is word-boundary matched, never a substring test.**
  `'female'.includes('male')` is `true`, and a substring pass therefore ticks
  Female for a user who stored Male. Two-character values skip the loose pass
  entirely, or "SC" would hit "SC/ST" and everything near it.
- **`CHOICE_ONLY` keys never fill free text.** `gender`, `category` and
  `maritalStatus` only fill a control with a fixed set of options. `category` is
  a generic enough word to match a box labelled "Job Category", and "OBC" typed
  into that is wrong rather than merely useless.

## The demo must never become a mock-up

`demo.html` fills a pretend form in front of somebody deciding whether to trust
this extension with their identity documents. Its decisions therefore come from
`lib/match.js` — the real matcher, the real `NEVER` and `THIRD_PARTY` guards —
never from a script of plausible-looking outcomes. Faking it would be a lie told
at exactly the moment trust is being extended, and `npm run audit` fails if the
real calls disappear. It reads no vault, writes no storage, and its sample
identity is fake all the way down (`example.com`, an Aadhaar masked to four
digits like a real one).

What it deliberately does *not* reuse is `content.js`'s field scanner — a second
copy of that would drift. It walks its own fixed twenty fields; only the
matching is shared.

## Working agreement

- **One phase per session.** Stop at phase boundaries, never mid-phase.
- After each phase: load the extension, run the phase's "done when" check, then
  commit as `phase N: short name`.
- Prefer small, reviewable changes over large rewrites.
- Test before claiming done. If something is unverified, say so plainly.

## Testing

- Reload after edits: `chrome://extensions` → ↻ on the FormPilot card.
- Service-worker console: click the **service worker** link on the card.
- Popup console: right-click inside the popup → **Inspect**.
- Confirm ciphertext at rest: `chrome.storage.local.get('vault', console.log)` —
  no readable personal values should appear anywhere in the output.
- Crypto changes can be exercised under Node (`node --experimental-vm-modules`
  not needed; Node exposes the same Web Crypto API on `globalThis.crypto`).
