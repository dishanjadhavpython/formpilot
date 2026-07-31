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
| 3 | Resize/compress to portal spec | ⬜ |
| 4 | OCR auto-extract (stretch) | ⬜ |
| 5 | Polish & reliability | ⬜ |

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

**Deferred out of this phase:** change-passphrase flow; idle auto-lock (Phase 5);
images capped at 2 MB until the Phase 3 compressor exists.

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

**Deferred:** checkbox/radio/file inputs; same-origin iframes; a UI for
reviewing and deleting saved site mappings.

## Phase 3 — Resize/compress to portal spec ⬜

Vendor `browser-image-compression` into `/vendor`. Pick an image + a preset
`{format, maxWidthOrHeight, minKB, maxKB}`. Resize the longest edge, then
binary-search JPEG quality with `canvas.toBlob` until the size lands in band.
3 presets + custom. Show original vs result and percent saved. Handle the
impossible-band case gracefully. Save to vault + download.

**Done when:** a big photo + a "10–200 KB JPEG" preset yields a file inside that
band at the right dimensions.

## Phase 4 — OCR auto-extract (stretch) ⬜

Vendor `tesseract.js` core + worker + eng traineddata into `/vendor`; set
`corePath`/`workerPath`/`langPath` to local files. Run in the worker with a
progress indicator; pre-fill fields with light regex heuristics (PAN pattern,
DOB, name line); show confidence; let every field be corrected.

**Done when:** a clear PAN/marksheet image pre-fills a couple of fields.

## Phase 5 — Polish & reliability ⬜

Idle auto-lock (the `autoLockMinutes` setting is already stored and unused).
Encrypted export/import so data survives a reinstall. Empty and error states.
README with setup, features, and the privacy line. Self-review for anything that
could store plaintext or auto-submit.

**Done when:** lock-on-idle works, and you can export, reinstall, import, recover.

---

## Definition of done (v1)

- Loads as an unpacked MV3 extension with no console errors.
- Vault stores fields + document images, encrypted; unlocks by passphrase;
  auto-locks on idle.
- "Fill this form" fills a real web form with review and no auto-submit.
- Image tool outputs a file inside a chosen KB band at the right dimensions.
- (Stretch) OCR pre-fills a couple of fields with confidence shown.
- Encrypted export/import works; README present; everything runs offline.
