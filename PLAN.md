# FormPilot — build plan

From `FormPilot_Build_Guide.pdf`. One phase per session; stop at boundaries,
never mid-phase. After each phase: load unpacked, run the "done when" check,
commit as `phase N: short name`.

Rules that apply to every phase are in [CLAUDE.md](CLAUDE.md).

| # | Phase | Status |
|---|-------|--------|
| 0 | Setup & scaffold | ✅ done — `ce1b2ab` |
| 1 | Encrypted vault | ✅ done — `e745ef4` |
| 2 | Autofill engine | ✅ done |
| 3 | Resize/compress to portal spec | ✅ done |
| 4 | OCR auto-extract (stretch) | ✅ done |
| 5 | Polish & reliability | ✅ done |
| 6 | Document (file-upload) autofill | ✅ done |

---

## Phase 0 — Setup & scaffold ✅

MV3 skeleton: `manifest.json` (storage, activeTab, scripting; `<all_urls>`),
service worker, popup with a title and one button, options page, icons.

**Done when:** the extension loads with no errors and the popup opens.

## Phase 1 — Encrypted vault ✅

Passphrase setup + unlock via Web Crypto. PBKDF2 (random salt, 310k iterations)
→ AES-256-GCM (random IV per save), stored in `chrome.storage.local`. Fields:
fullName, dob, email, phone, address, pan, aadhaarMasked, plus custom fields and
document images by type. Lock/unlock buttons.

**Done when:** add data, lock, reload, unlock, see it again — and the raw stored
value is unreadable ciphertext.

**Deferred out of this phase:** change-passphrase flow; idle auto-lock (Phase 5).
Direct document attachment is capped at 2 MB; larger files go through the Phase 3
image tool, which compresses then saves to the vault.

## Phase 2 — Autofill engine ✅

The core feature. `content.js` scans the page and infers each field's meaning;
the popup's "Fill this form" button sends vault data to it.

**Resolved design decision.** The popup cannot decrypt anything — the key is
non-extractable and lives in the options page. On unlock, the options page
publishes the *decrypted text fields* (not the key, not the documents) to
`chrome.storage.session`, which is memory-only, never hits disk, and is pinned
to `TRUSTED_CONTEXTS`. The popup reads that and hands values to the content
script. Cleared on Lock and on browser restart.

- Match order: taught per-site mapping → `autocomplete` attribute → name / id /
  label / placeholder / aria-label against the synonyms in `lib/match.js`.
  Ties break toward the longest matched synonym, so "first name" beats "name".
- `content.js` is injected on demand via `chrome.scripting.executeScript`, not
  declared in the manifest — it never runs on a page you did not ask it to.
- Fills via the native prototype value setter (React/Vue ignore plain `.value`
  assignment), then dispatches `input` + `change`.
- Outlines filled fields, shows "filled X of Y" in a Shadow-DOM toast.
- Safety: never submits, never fills passwords, skips hidden honeypots, and
  never overwrites a field that already has a value.
- Teach mode: click a field on the page, label it, and the mapping is saved to
  `local.siteMappings` under that hostname for next time.

**Done when:** on a real signup form, "Fill this form" fills your stored fields,
highlights them, and does not submit.

**Deferred:** checkbox/radio/file inputs; same-origin iframes.
(The mappings review/delete UI landed alongside Phase 3.)

## Phase 3 — Resize/compress to portal spec ✅

`lib/image.js` + the Image tool section of the options page. Pick an image and a
preset `{format, maxWidthOrHeight, minKB, maxKB}`; the longest edge is scaled to
the limit, then JPEG quality is binary-searched with `canvas.toBlob` until the
output lands inside the band. 3 presets plus a custom-spec form whose specs can
be saved. Shows original vs result, percent saved, dimensions, quality and
encode count, with Save-to-vault and Download.

**The band is the point.** Ordinary compressors target a *maximum*; portals
specify a floor as well, and a 6 KB file gets rejected just as surely as a 6 MB
one. Failure is diagnosed rather than hidden: `TOO_BIG`, `TOO_SMALL`,
`BAND_TOO_NARROW` and `INVALID_BAND` each explain which end failed, and the
nearest miss is still offered with an explicit out-of-band warning.

**Vendoring caveat — read `vendor/README.md`.** `browser-image-compression`'s
default export violates MV3 unless `useWebWorker: false` is passed: it builds a
worker from a `blob:` URL and `importScripts` the library from jsDelivr at
runtime. `lib/image.js` uses only the documented namespace helpers
(`drawFileInCanvas`, for EXIF-correct decoding) and never the default export, so
neither path is reachable.

**Done when:** a big photo + a "10–200 KB JPEG" preset yields a file inside that
band at the right dimensions.

**Deferred:** cropping / aspect-ratio enforcement (portals that demand exactly
3.5x4.5 cm need a crop step, not just a scale); PNG can only be tuned by
dimension because the encoder ignores the quality argument.

## Phase 4 — OCR auto-extract (stretch) ✅

`lib/ocr.js` + the "Read an ID image" section. tesseract.js 7.0.0 with core
7.0.0 and the English LSTM model, all vendored (~6.8 MB) — see
`vendor/README.md`, which documents the three CDN fetches that had to be
overridden, the `workerBlobURL: false` requirement, why only one of six core
variants is shipped, and the version-pairing trap where npm's `latest` core tag
is *older* than the one tesseract.js 7 requires.

Required a manifest change: MV3 blocks all WebAssembly without
`'wasm-unsafe-eval'` in the extension CSP.

Heuristics: PAN (with digit/letter OCR-confusion repair), date of birth in three
formats with range validation, Aadhaar (masked to the last 4 digits inside the
extractor), and a name line picked as the most confident all-caps line that is
not a known label. Every suggestion is editable and individually tickable;
Apply writes into the visible form, and only "Save vault" encrypts it.

**Done when:** a clear PAN/marksheet image pre-fills a couple of fields.

**Deferred:** no image pre-processing (deskew, threshold, upscale), which is the
biggest available accuracy win on phone photos; English only; the name-line
heuristic is weak on layouts where the name is not in capitals.

## Phase 5 — Polish & reliability ✅

**Idle auto-lock.** Driven by `chrome.alarms` in the service worker, not by a
page — the vault has to lock itself when every extension page is closed, and a
worker variable would not survive the worker sleeping. Re-armed on activity, so
"5 minutes" means five minutes of *inactivity*. When it fires it removes the
session copy; an open options page sees that via `chrome.storage.onChanged` and
drops its in-memory key to match. Added the `alarms` permission.

**Encrypted export/import** (`lib/backup.js`). No new cryptography: the stored
record is already a self-describing encrypted envelope, so a backup is that
envelope in a file. Import validates the shape before writing — a malformed
record would leave the vault permanently unopenable — then forces a re-unlock
with the passphrase that backup was made under. The Backup section is visible in
*every* state, because restoring is what you need right after a reinstall, when
no vault exists and the page is in setup.

**Error states.** `window.onerror` / `unhandledrejection` surface into a banner;
a thrown error in a handler otherwise fails silently and the page just looks
broken.

**Self-review found a real leak.** `lock()` cleared the key and the vault fields
but left OCR-recognised text in the DOM, the image tool's `lastResult` Blob and
its live object URL, the preview `<img>` still showing a document, and the file
inputs still naming what you picked. All of that came off your documents. Split
into `lockLocally()` (tear down this page, safe to call when the session copy is
already gone) and `lock()` (that plus revoking the popup's copy).

**Done when:** lock-on-idle works, and you can export, reinstall, import, recover.

**Deferred:** no change-passphrase flow, so a backup is forever tied to the
passphrase in force when it was taken.

## Phase 6 — Document (file-upload) autofill ✅

Portals that ask you to upload an Aadhaar/PAN/photo/signature image were
untouched by Phase 2 - `input[type=file]` was explicitly in `SKIP_TYPES`, and
vault documents were explicitly excluded from the `chrome.storage.session`
copy the popup/content script fill from. Both gaps close together: document
labels ("Upload Aadhar Card Image", "Upload Signature") are matched against a
small synonym table in `lib/match.js` (`DOC_SYNONYMS`, keyed by the same
`photo`/`signature`/`pan`/`aadhaar`/`idProof` type ids `options.js` already
uses), and the matching stored image is attached via
`el.files = dataTransfer.files` on the same trusted click that fills text.

- `publishSession()` now includes one document per type (most recently
  added) alongside the text fields. `chrome.storage.session` has its own
  ~10MB quota; a publish that goes over it retries once with documents left
  out rather than losing text autofill too.
- Detection reports document *types and mimes* (`docKeys`/`docMimes`),
  matching how it already reports text *key names* - never the image itself.
  Real bytes only cross in a FILL, in a `docs` map scoped to the types the
  page's plan asked for, after the same trusted click as everything else.
- File inputs use a looser visibility check than text fields
  (`isFillableDoc`, `content.js`): hiding a file input under a styled "Add
  File" button with `opacity:0` is normal UI, not a honeypot, so only actual
  unreachability (`display:none` ancestor, off-screen position) disqualifies
  one. Reusing the text-field honeypot check verbatim would have broken the
  feature on the exact pattern it exists to handle.
- `el.accept` is checked against the stored document's mime
  (`M.acceptsMime`) so a field pinned to `.pdf` is correctly left alone - the
  vault only ever stores images.

**Done when:** a vault with Aadhaar/PAN/signature images saved, opened
against a form with three `input[type=file]` fields labelled "Upload Aadhar
Card Image" / "Upload PAN Card Image" / "Upload Signature" (one a plain file
input, one styled as a custom button with the native input visually hidden),
attaches the right image to the right field on one Fill click, leaves a field
alone if it already has a file picked, and never touches submit.

**Deferred:** PDF/other document formats (vault only stores images);
`multiple` file inputs; document types outside the Identity group
(marksheets etc.); teach-mode labelling for document slots.

---

## Definition of done (v1)

- Loads as an unpacked MV3 extension with no console errors.
- Vault stores fields + document images, encrypted; unlocks by passphrase;
  auto-locks on idle.
- "Fill this form" fills a real web form with review and no auto-submit.
- Image tool outputs a file inside a chosen KB band at the right dimensions.
- (Stretch) OCR pre-fills a couple of fields with confidence shown.
- Encrypted export/import works; README present; everything runs offline.
