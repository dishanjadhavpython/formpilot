# FormPilot

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

1. Click the FormPilot icon → **Open vault**
2. Choose a passphrase. It encrypts everything, and it is never stored anywhere.
   **If you forget it, the data is gone** — that is what encryption means, and
   there is no reset.
3. Fill in your details, attach document images, press **Save vault**

---

## Features

### Encrypted vault
Personal fields (name, date of birth, email, phone, address, PAN, masked
Aadhaar), any number of custom fields, and document images — all encrypted at
rest with AES-256-GCM under a key derived from your passphrase.

### Form autofill
Open any form, click **Fill this form**. FormPilot infers what each field wants
and fills it, outlines what it touched, and reports "filled X of Y".

It **never submits the form**, never fills password fields, skips hidden
honeypot fields, and never overwrites something you already typed. Review and
submit yourself, always.

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
| `activeTab` | Reading the current tab's fields, only when you click Fill |
| `scripting` | Injecting the fill script into that tab on demand |
| `alarms` | The idle auto-lock countdown |
| `<all_urls>` | Filling forms on any site you choose to use it on |

`content.js` is **not** declared in the manifest — it is injected only when you
press a button, so it never runs on pages you did not ask about.

The extension CSP carries `'wasm-unsafe-eval'`, required by the OCR engine's
WebAssembly. Despite the name it does not permit `eval()` or remote code;
scripts are still confined to files shipped inside the extension.

---

## Backup and restore

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
content.js             field detection and filling (injected on demand)
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
- Autofill does not handle checkboxes, radio groups, file inputs or iframes.
- The image tool scales but does not crop, so specs demanding an exact aspect
  ratio (3.5×4.5 cm) need cropping elsewhere first.
- No cloud sync and no mobile app, by design.

## Licence

Third-party components keep their own licences — see [`vendor/`](vendor/):
`browser-image-compression` (MIT), `tesseract.js` and `tesseract.js-core`
(Apache-2.0).
