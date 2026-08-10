# FormPilot — project overview

The single place to get the whole picture. Each topic below is covered in
depth by its own file; this one is the map and the current state.

---

## What it is

A local-first Chrome/Edge/Brave extension (Manifest V3): an encrypted document
vault, form autofill that infers what each field wants, an image tool that
compresses a photo into a portal's exact KB band, and on-device OCR that reads
PAN cards, Aadhaar cards and marksheets. No backend, no accounts, no network
calls of any kind — the whole feature set works with the device offline.

Repo: [github.com/dishanjadhavpython/formpilot](https://github.com/dishanjadhavpython/formpilot)

## Why it's built the way it is

Every one of these is a deliberate constraint, not a limitation that crept in:

- **Vanilla JS, HTML, CSS. No framework, no bundler, no build step.** The
  folder on disk is exactly what Chrome loads with "Load unpacked" — nothing
  is compiled, transpiled or generated.
- **No network, enforced twice.** Nothing in the source makes a request
  (`npm run audit` greps for `fetch`/`XMLHttpRequest`/etc. on every commit),
  and the CSP's `connect-src 'self'` blocks one at the browser level even from
  code that tried.
- **Personal data is encrypted or it doesn't get written.** Exactly three
  unencrypted storage keys exist in the whole project, each justified in
  [CLAUDE.md](CLAUDE.md), and a fourth needs a real reason, not a convenient
  one.
- **A web page is told what the vault can answer, never what the answer is.**
  The content script lives inside somebody else's page. Detection carries key
  names only; real values cross only in the two messages immediately around a
  trusted click.
- **Nothing submits itself.** No `form.submit()`, no synthetic Enter, no
  `.click()` on someone else's button, anywhere in the codebase — checked by
  the audit, not just by convention.

These are the hard rules in [CLAUDE.md](CLAUDE.md); that file is the one every
change is checked against, including changes I make.

## Architecture

Four contexts, talking only through `chrome.runtime`/`chrome.tabs` messages —
they cannot call each other's functions directly, MV3 forbids it:

```
                    ┌─────────────────────┐
                    │  background.js      │  service worker (ephemeral —
                    │  (the router)        │  Chrome kills it when idle)
                    └──────────┬───────────┘
                 ACTIVITY/LOCK_NOW/REQUEST_FILL/DETECT
              ┌───────────────┼───────────────────┐
              │                │                    │
      ┌───────▼──────┐ ┌───────▼───────┐   ┌────────▼─────────┐
      │  popup.js     │ │  options.js    │   │  content.js       │
      │  Fill button,  │ │  vault, image  │   │  injected into a  │
      │  PLAN/FILL     │ │  tool, OCR,    │   │  web page only    │
      │  two-pass send │ │  settings      │   │  when unlocked    │
      └───────────────┘ └────────────────┘   └───────────────────┘
```

- **`background.js`** — the service worker. Runs the idle auto-lock alarm,
  scans each new page for fillable fields (badging the toolbar icon), and is
  the only thing that ever releases real vault *values and documents* to a
  content script, gated on sender identity, the optional `<all_urls>`
  permission actually being granted, an http(s) tab, the vault being unlocked,
  and suggestions being on — all re-checked on every release, not cached from
  detection time.
- **`popup.js`** — the toolbar button's UI. Sends a `PLAN` (key names only),
  then a `FILL` (values for just those keys) — two messages on purpose, so a
  page that turns out to want nothing never sees anything.
- **`options.js`** — the vault itself: passphrase setup/unlock, the encrypted
  fields and document images, the image-resize tool, OCR, saved site
  mappings, settings, and encrypted export/import. The only page that ever
  holds the decryption key.
- **`content.js`** — injected on demand (never declared in the manifest, so it
  never runs on a page you didn't implicitly ask about), detects fillable
  fields, renders the inline suggestion chip in a **closed** Shadow DOM, and
  fills — but only after a real, browser-trusted click.
- **`lib/`** — the pure logic, framework-free and unit-tested under Node:
  `crypto.js` (PBKDF2 → AES-256-GCM), `match.js` (field inference + the
  synonym map + what's safe to tell a page), `image.js` (the KB-band search),
  `ocr.js` (Tesseract config + PAN/date/Aadhaar/name heuristics), `backup.js`
  (export/import envelope + validation of any record before it's trusted).

## Features

Full detail, with the *why* behind each: **[README.md](README.md)**.

| | |
|---|---|
| Encrypted vault | Name, DOB, phone, address, PAN, masked Aadhaar, gender/category/marital status, unlimited custom fields and labelled emails, document images by type |
| Autofill | Notices a form on its own (badge + inline chip), or click "Fill this form". Infers field meaning from label/name/autocomplete/synonyms, including radio groups, `<select>`s, and single-file image uploads (Aadhaar/PAN/photo/signature) matched by label. Never submits, never ticks a checkbox, never fills passwords, never overwrites, never fills someone else's field with your data |
| Teach mode | Click a field, label it, remembered per-site for next time |
| Image tool | Compress into an exact KB band (not just a maximum) at a target pixel size; 3 presets + custom specs |
| OCR | On-device PAN/Aadhaar/marksheet reading, editable suggestions, nothing saved until you say so |
| Auto-lock + backup | Idle timeout (default 5 min), encrypted export/import |

## Security model

Full threat table and the reasoning behind every mitigation:
**[SECURITY.md](SECURITY.md)**.

The short version: PBKDF2-SHA256 (310,000 rounds) → AES-256-GCM with a fresh
IV every save; the derived key is non-extractable and lives only in page
memory; unlock attempts are throttled with exponential backoff; an imported —
or already-stored — vault record is validated (algorithm, iteration bounds,
IV/salt/ciphertext sizes) before a passphrase is ever fed to it, because a
crafted record is a working attack, not just an invalid file; the in-page
suggestion UI is a closed Shadow DOM behind an `isTrusted`-click check so the
page it's injected into can't drive it itself; and `externally_connectable`
is locked to no other extension.

## Where things stand

**All six build phases are done** (see [PLAN.md](PLAN.md) for the log of each
one — scaffold → encrypted vault → autofill → image resize → OCR → polish),
plus two passes after v1 that aren't phases in that plan:

1. **A security-hardening pass** — rewrote the detection/fill messages to a
   PLAN/FILL split so values never cross into a page speculatively, closed the
   suggestion chip's Shadow DOM, added sender checks on every message,
   hardened the CSP, added unlock throttling, and added the record validation
   described above. Landed as `SECURITY.md` plus two new test suites
   (`security.test.mjs`, running the code; `audit.test.mjs`, statically
   scanning the source for the rules in `CLAUDE.md`) and a mutation-testing
   harness (`audit-mutations.mjs`) that proves the audit actually catches a
   real regression rather than reporting green forever. One real bug turned
   up in review: the options page's own activity pings were being rejected by
   a sender check that assumed extension pages never run inside a tab —
   `options_ui.open_in_tab` says otherwise — which would have force-locked the
   vault on a flat timer regardless of activity. Fixed, with a regression test
   modeling the real sender shape.

2. **A real-browser verification pass** — rather than trust static review
   alone, the extension was actually loaded and driven end-to-end in Brave
   (headless, over the Chrome DevTools Protocol) with a real vault, a real
   fill against a self-grading test form, real image compression, and real
   OCR, watching for console errors and network requests throughout. That
   surfaced two bugs no amount of reading the code would have:
   - **Image resize crashed** whenever an uploaded image already fit the
     target size (a common case). The vendored compression library returns an
     `OffscreenCanvas` on every current Chromium browser, which has no
     `toBlob()` — only `HTMLCanvasElement` does. Fixed with a feature-detecting
     fallback to `convertToBlob()`.
   - **OCR results were computed but never shown.** The results panel's
     `hidden` class was only ever added, never removed, so every OCR run
     produced real extracted fields the user could never see or apply.
   - Confirmed empirically (not just by reading the code): the closed Shadow
     DOM really is unreachable from the page, a fill delivers exactly the
     planned keys and nothing else, zero plaintext ever reaches
     `chrome.storage.local`, and — watched directly over the network — OCR
     makes zero requests to anything but `chrome-extension://` URLs.

   **Chrome Stable could not be driven directly**: it now silently ignores
   `--load-extension`/`--disable-extensions-except` (a Google anti-malware
   restriction with no user-facing override, and no Dev/Canary channel was
   available to route around it). Verification ran on Brave, which shares the
   same extension engine and every API surface FormPilot uses; Chrome and
   Edge are believed sound on the same evidence but haven't been driven
   directly — worth the 30-second manual "Load unpacked" check before
   treating them as equally proven.

**Test suite: 337 assertions, all passing**, across 8 suites (crypto, field
matching, image band search, OCR heuristics, backup validation, security
behaviour, static audit, mutation proof) — run with `npm test`. See
[run.md](run.md) for the full testing/dev-loop walkthrough, including how to
serve `test/form.html` for a live autofill check.

## Layout

```
LICENSE                MIT
PRIVACY.md             privacy policy — the hosted URL the store listing needs
.github/workflows/     CI: every suite on every push and pull request
manifest.json          MV3 manifest: permissions, CSP, externally_connectable
background.js          service worker — routing, idle auto-lock, detection, shortcut
popup.html / popup.js  toolbar button — the Fill/Teach flow
options.html / .js     vault, image tool, OCR, mappings, backup, settings
welcome.html / .js     first run — opened once, on install
demo.html / .js        try-it sample form — real matcher, fake person, no vault
content.js             injected on demand — detection, chip UI, filling
tools/  shipped.mjs    the single answer to "which files does the browser get"
        checksums.mjs  fingerprints every shipped file (release verification)
        package.mjs    builds the reproducible store ZIP (npm run package)
store/                 listing copy, permission justifications, launch checklist
lib/
  crypto.js            PBKDF2 + AES-256-GCM
  match.js             field inference, synonyms, what's safe to expose
  image.js             KB-band search over canvas encoding
  ocr.js               Tesseract config + text-pattern heuristics
  backup.js            export/import envelope + record validation
vendor/                third-party code, vendored (no CDN, ever) — see vendor/README.md
styles/                one-ui.css (design tokens/components) — see DESIGN.md
test/
  run.mjs              runs every suite
  *.test.mjs           the suites themselves
  form.html             self-grading fixture for a live autofill check
CLAUDE.md              hard rules — read before touching security-relevant code
PLAN.md                phase-by-phase build log
DESIGN.md              the UI design system ("One UI")
SECURITY.md            full threat model and mitigations
README.md              install, features, privacy, testing — the public-facing doc
run.md                 first run, dev loop, troubleshooting
```

## Known limitations

- English OCR only; no image pre-processing (deskew/threshold), which would be
  the biggest accuracy win on phone photos.
- Autofill doesn't handle `multiple` file inputs or same-origin iframes.
  Checkboxes are refused permanently and on purpose (hard rule 1a — ticking one
  asserts something on the user's behalf); radio groups and `<select>`s *are*
  filled, via `chooseOption()`. Single-file image uploads are handled for a
  fixed set of document types (photo, signature, PAN, Aadhaar, other ID proof)
  — see Phase 6 in PLAN.md — but not marksheets/other types, and not PDF
  uploads (the vault only ever stores images).
- The image tool scales but doesn't crop, so an exact-aspect-ratio spec (e.g.
  3.5×4.5 cm) needs cropping done elsewhere first.
- No change-passphrase flow — a backup is tied to the passphrase in force when
  it was taken.
- No cloud sync, no mobile app — by design, not by omission.
- Edge hasn't been driven directly by an automated real-browser test (see
  above); Chrome Stable can't be, by Chrome's own policy.

## Quick reference

| I want to... | Go to |
|---|---|
| Install and use it | [README.md](README.md) → Install / First run |
| Understand a feature's behaviour | [README.md](README.md) → Features |
| Check what's safe to change | [CLAUDE.md](CLAUDE.md) → Hard rules |
| Know what is stored and where | [PRIVACY.md](PRIVACY.md) |
| See how a phase was built | [PLAN.md](PLAN.md) |
| Understand the security model | [SECURITY.md](SECURITY.md) |
| Match a UI change to the design system | [DESIGN.md](DESIGN.md) |
| Run the extension locally / dev loop | [run.md](run.md) |
| Run the test suite | `npm test` (or see [run.md](run.md)) |
| Check a vendored library's provenance | [vendor/README.md](vendor/README.md) |
