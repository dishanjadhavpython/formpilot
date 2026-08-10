# FormPilot

[![tests](https://github.com/dishanjadhavpython/formpilot/actions/workflows/test.yml/badge.svg)](https://github.com/dishanjadhavpython/formpilot/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

A local-first Chrome/Edge extension (Manifest V3) that keeps your personal
details and document images in an encrypted vault, fills web forms from it,
resizes images to a portal's exact spec, and reads text off ID cards.

**All data stays on your device.** No account, no server, no network calls,
works offline.

---

## Install

There is no Web Store listing; load it unpacked. For the full walkthrough —
first run, verifying each feature, the development loop and troubleshooting —
see **[run.md](run.md)**.

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this folder — the one containing
   `manifest.json`
4. Pin **FormPilot** from the puzzle-piece menu

Re-run step 4's reload button (↻) on the extension card after any code change.

Nothing to install, build or compile: no npm dependencies at runtime, no bundler,
no build step. Everything third-party is committed under [`vendor/`](vendor/).

## First run

Installing opens a welcome page. From there you can **try it on a sample form**
before committing anything — a pretend application form filled with made-up
details, which touches no vault and asks for nothing. It runs the real matcher,
so what you see it fill (and refuse) is what it would really do.

When you are ready:

1. Click the FormPilot icon → **Open vault**
2. Choose a passphrase. It encrypts everything, and it is never stored anywhere.
   **If you forget it, the data is gone** — that is what encryption means, and
   there is no reset.
3. Fill in your details, attach document images, press **Save vault**

Once a vault is unlocked, **Ctrl+Shift+F** (**⌘⇧F** on a Mac) fills the page you
are on without opening the popup. Rebind it at `chrome://extensions/shortcuts`.

## Verify what you installed

FormPilot has no build step: no bundler, no minifier, nothing generated. The
folder Chrome loads is the folder in this repository, byte for byte — so unlike
almost any other extension, you can check that the code you read is the code
that runs.

```bash
npm run checksums          # every shipped file, plus one aggregate hash
```

Compare that against the same command run inside the copy your browser actually
installed (Chrome keeps it under your profile's `Extensions/<id>/<version>/`),
or diff the two trees directly:

```bash
diff -r . ~/path/to/profile/Extensions/<extension-id>/<version>/ \
  --exclude=.git --exclude=test --exclude=tools --exclude=node_modules
```

Expect no output. Any difference at all is one worth asking about.

The store package is built the same way and is **reproducible** — every
timestamp is pinned, so `npm run package` on the same source produces a
byte-identical ZIP. That is what makes the published release hash meaningful
rather than decorative.

---

## Features

### Encrypted vault
Personal fields (name, date of birth, email, phone, address, PAN, masked
Aadhaar, plus gender, category and marital status for the choice fields portal
forms ask for), any number of custom fields, and document images — all encrypted
at rest with AES-256-GCM under a key derived from your passphrase.

**Several email addresses.** Keep a main address plus any number of extras
labelled Personal, Work, College, Alternate or Parent/Guardian. A form asking
for "Work email" gets the work one, not your primary — the label carries real
matching synonyms, so a qualified field beats the generic guess.

**Document types** cover identity (photo, signature, PAN, Aadhaar, other ID) and
education: 10th/SSC, 12th/HSC, Diploma, Degree/Bachelor's, Master's and PhD.

### Form autofill
FormPilot notices a fillable form on its own: the toolbar icon shows how many
fields it can fill, and a small prompt appears on the page offering to do it.
Nothing is filled until you click. Turn it off with **Offer to fill when a form
is detected** in Settings.

You can also open any form and click **Fill this form** directly. FormPilot infers what each field wants
and fills it, outlines what it touched, and reports "filled X of Y".

It **never submits the form**, never fills password fields, skips hidden
honeypot fields, and never overwrites something you already typed. Review and
submit yourself, always.

**Radio buttons too.** Gender, Category and Marital status — the dropdowns and
radio groups portal forms are dense with — are answered from the vault. A group
is only answered if one of its options actually matches what you stored, so a
misread question does nothing rather than something wrong.

**But it never ticks a checkbox**, and that is deliberate rather than
unfinished. A checkbox on these forms is almost always a statement *you* are
making — "I hereby declare the above to be true", "I accept the terms". Ticking
it would be FormPilot asserting that for you, which is the same thing as
pressing Submit for you. It doesn't do either.

It also leaves **other people's fields alone**. "Father's Name", "Spouse Email",
"Nominee", "Emergency Contact" and the like are never filled with your own
details — only with a value you explicitly labelled for that person, or one you
taught for that site.

Got it wrong? **Teach fields on this site** — click a field, say what it is, and
it is remembered for that site. Saved mappings are listed in the options page
and can be deleted.

### Resize to portal spec
Portals demand things like "JPEG, max 600px, between 10 KB and 200 KB". Most
compressors only target a maximum, so they hand back a 6 KB file that gets
rejected. FormPilot searches for a result inside the **band**, and when a band is
genuinely unreachable it says which end failed instead of returning something
that will bounce.

Three presets (passport photo, signature, document scan) plus custom specs you
can save.

**Crop to a shape too.** A portal asking for "3.5 × 4.5 cm" is asking for an
aspect ratio, and scaling cannot change one — only cutting can. Pick a shape
(passport photo, square, signature strip, A4), drag the image to choose what to
keep, zoom in if you need to. The rest of the picture is shaded rather than
hidden, so you can see what you are giving up before you commit.

### OCR
Point it at a PAN card, Aadhaar or marksheet and it suggests values for your
fields, with a confidence score. Every suggestion is editable and individually
tickable, and nothing is saved until you press **Save vault**. Runs entirely
on-device.

### Auto-lock and backup
The vault locks itself after a period of inactivity (configurable, default 5
minutes) and whenever you close the browser. Export an encrypted backup so your
data survives a reinstall.

---

## Privacy

**Everything stays on your device.** FormPilot makes no network requests of any
kind — no sync, no analytics, no telemetry, no crash reporting. There is nothing
to opt out of.

How the encryption works:

- Your passphrase is stretched into a 256-bit key with **PBKDF2-SHA256**,
  310,000 iterations, against a random per-vault salt.
- The vault is encrypted with **AES-256-GCM**, with a **fresh random IV on every
  save**.
- The derived key is non-extractable and exists only in memory. It is never
  written to disk, never logged, never sent anywhere.
- There is no stored password hash. A failed decryption *is* the wrong-passphrase
  signal, which means there is nothing to attack offline but the ciphertext.
- Nobody can recover a forgotten passphrase. Not you, not us — there is no "us".

What is stored **unencrypted**, and why:

| Key | Contents | Why |
|---|---|---|
| `local.settings` | Auto-lock minutes, highlight toggle, saved image presets | Preferences. No personal data. |
| `local.siteMappings` | `hostname → { css selector: field name }` | Field *names*, never values. Read by the popup while the vault may be locked. The hostnames are already in your browser history. |
| `session.vaultData` | Your text fields, while unlocked | Lets the popup fill forms without your passphrase. `chrome.storage.session` is **memory-only — never written to disk** — restricted to trusted extension contexts, and cleared on lock and on browser restart. Document images are excluded. |

Verify the offline claim yourself: open DevTools on the options page, watch the
Network tab, and use every feature. Every request should be a
`chrome-extension://` URL.

### Aadhaar

Only the **last four digits** are ever kept, and the masking happens before the
value reaches the vault — paste a full number and the rest is discarded on the
spot. This follows UIDAI guidance to mask by default and store the minimum.

## Permissions

| Permission | Used for |
|---|---|
| `storage` | Keeping the encrypted vault and your settings |
| `activeTab` | Reading and filling the current tab's fields, only when you click Fill |
| `scripting` | Injecting the fill script into that tab on demand |
| `alarms` | The idle auto-lock countdown |
| `<all_urls>` | **Optional — not requested at install.** Only asked for if you switch on "Offer to fill when a form is detected", because watching for forms means seeing the pages you open |

**FormPilot does not ask for access to your websites when you install it.**
Chrome's alarming "read and change all your data on all websites" prompt comes
from a *required* `<all_urls>` permission; FormPilot declares it as
`optional_host_permissions`, so you are asked only if and when you turn on
proactive form detection — and turning that setting back off hands the access
straight back. Decline it and everything still works; FormPilot just waits to be
asked instead of watching. Clicking **Fill this form** runs on `activeTab`,
which grants access to that one tab and nothing else.

`content.js` is **not** declared in the manifest. It is injected
programmatically, and for proactive detection only when all four of these hold:
the `<all_urls>` permission is granted, the page is http(s), **the vault is
unlocked**, and form suggestions are switched on. Lock the vault and the
extension stops touching web pages entirely.

The extension CSP carries `'wasm-unsafe-eval'`, required by the OCR engine's
WebAssembly. Despite the name it does not permit `eval()` or remote code;
scripts are still confined to files shipped inside the extension.

---

## Backup and restore

**Change passphrase** re-encrypts everything under a new one. It asks for your
current passphrase first — being unlocked is not authorisation, since anyone
sitting at an unattended machine is also "unlocked" — and the new record is
decrypted and proven to open *before* anything is written, because a
half-applied change would be a vault nothing could open.

Existing backup files keep needing the **old** passphrase. Export a fresh one
afterwards.

**Export** writes the encrypted vault to a `.formpilot-backup` file — the same
ciphertext that sits in storage, so it is only as strong as the passphrase that
produced it. Keep it somewhere you control.

**Import** replaces the vault on this device and needs the passphrase that
backup was made with. Available even with no vault present, which is the case
right after a reinstall.

## Layout

```
manifest.json          background.js      service worker: messaging, idle auto-lock
popup.html / .js       the Fill this form button
options.html / .js     vault, image tool, OCR, mappings, backup, settings
content.js             field detection, suggestion chip and filling
lib/  crypto.js        PBKDF2 + AES-GCM
      match.js         field inference and the synonyms map
      image.js         resize and file-size band search
      ocr.js           tesseract.js configuration and text heuristics
vendor/                third-party code, local copies only (see vendor/README.md)
styles/one-ui.css      the design tokens and components (see DESIGN.md)
test/  run.mjs         runs every suite; *.test.mjs are the suites
       form.html       a form that grades a fill, including the safety cases
```

Project rules are in [CLAUDE.md](CLAUDE.md); the phase-by-phase build log is in
[PLAN.md](PLAN.md).

## Testing

Automated checks — cryptography, field matching, the image band search, OCR
heuristics and backup envelopes:

```bash
npm test          # or: node test/run.mjs
```

They run under Node's Web Crypto, the same API the browser provides. They do not
cover anything DOM- or Chrome-shaped; that needs the browser.

For autofill, serve the fixture and fill it:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/test/form.html
```

The page grades itself: it has ten fields that should fill, plus a password, a
username, a company name, an OTP, a captcha, an off-screen honeypot and a
pre-filled email that must all be left alone. Anything red is a bug.

## Limitations

- English OCR only, with no image pre-processing — deskewing and thresholding
  would be the biggest accuracy win on phone photos.
- Autofill does not reach forms inside iframes. Text inputs, `<select>`
  dropdowns, radio groups and single-file image uploads (photo, signature, PAN,
  Aadhaar, other ID proof) are handled; `multiple` file inputs and PDF uploads
  are not — the vault only ever stores images. Checkboxes are refused on
  purpose, as above.
- Cropping is a single rectangle you position and zoom; there is no rotation,
  straightening or background removal.
- No cloud sync and no mobile app, by design.

## Privacy policy

[PRIVACY.md](PRIVACY.md) — the short version is that there is nothing to
collect, because there is nowhere to send it.

## Licence

FormPilot is [MIT licensed](LICENSE). Third-party components keep their own
licences — see [`vendor/`](vendor/): `browser-image-compression` (MIT),
`tesseract.js` and `tesseract.js-core` (Apache-2.0).
