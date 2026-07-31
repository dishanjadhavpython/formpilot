# Running FormPilot

Step by step, from a fresh clone to a working extension.

There is **no build step**. No `npm install`, no bundler, no compiler. The folder
loads into Chrome exactly as it sits on disk. Node is needed only for the
automated checks in step 5.

> **Status:** phases 0–5 are complete and the automated checks pass, but the
> extension has not yet been run in a browser. Step 4 is therefore real
> verification, not a formality — if something is broken, that is where it shows.

---

## 1. What you need

| | |
|---|---|
| **Google Chrome** or **Microsoft Edge** | Chromium 102+. Required. |
| **Node.js 20+** | Optional — only for `npm test`. |
| Anything else | Nothing. No accounts, no server, no network. |

Check what you have:

```bash
node --version      # v20 or newer, only if you want to run the checks
```

---

## 2. Load the extension

1. Open **`chrome://extensions`** — paste it in the address bar; a link cannot
   navigate there.
2. Turn on **Developer mode** (toggle, top right).
3. Click **Load unpacked** (top left).
4. Select the folder containing `manifest.json` — this folder. Select the folder
   itself, do not open it first.
5. A **FormPilot** card appears, version 0.1.0, with the blue "F" icon.
6. Click the puzzle-piece icon in the toolbar and **pin** FormPilot.

**Check before continuing:** the card must show no red **Errors** button. If it
does, click it — the message names the exact file and line.

---

## 3. First run — create your vault

1. Click the FormPilot icon → **Open vault ↗**. The options page opens in a tab.
2. Choose a passphrase (10+ characters) and confirm it.
3. Press **Create encrypted vault**.

There is a deliberate pause of roughly a quarter second — that is PBKDF2 doing
310,000 iterations. It is the feature, not lag.

> **The passphrase cannot be recovered.** Not by you, not by the extension.
> There is no reset, no email link, no backdoor. If you forget it, the data is
> gone. Use something you will remember, or write it down somewhere safe.

Now fill in some fields, then press **Save vault**.

---

## 4. Verify each feature

These are the "done when" checks from [PLAN.md](PLAN.md). Run them in order.

### 4.1 The vault really is encrypted

1. On the options page, press **F12** → **Console**.
2. Run:

   ```js
   chrome.storage.local.get('vault', console.log)
   ```

3. You should see `kdf`, `iv` and a long base64 `ciphertext`. **No readable
   name, email or PAN anywhere in the output.** If you can read your data, stop
   and report it — that is a serious bug.
4. Press **Lock**, reload the tab, unlock again. Your data comes back.
5. Try a wrong passphrase → *"Wrong passphrase, or the vault file is damaged."*

### 4.2 Autofill

Serve the test fixture:

```bash
python3 -m http.server 8000
```

Open **http://localhost:8000/test/form.html**, then click the FormPilot icon and
press **Fill this form**.

Serving over HTTP avoids needing the "Allow access to file URLs" toggle that a
`file://` page would require.

The page grades itself live:

- Ten fields should fill, and get a blue outline.
- The panel at the top must stay **green**. It turns red if anything filled a
  password, username, company name, OTP, captcha, or the off-screen honeypot, or
  if it overwrote the pre-filled email.
- The form must **never submit**. There is a submit button that raises an alert
  if anything triggers it.

Then try **Teach** — click a field on the page, label it, press Save. The mapping
appears under "Taught site mappings" on the options page.

### 4.3 Image tool

On the options page, scroll to **Image tool**. Pick a large phone photo and the
**Passport photo** preset (10–200 KB at ≤600px). Press **Resize to spec**.

You should get a file inside that band, with original vs result sizes and percent
saved. Try **Signature** (4–30 KB) on the same photo to watch it work harder.

To see graceful failure, choose **Custom spec…** and ask for something impossible
— a 1–2 KB band on a detailed photo. It should explain *which end* failed rather
than handing back a file the portal would reject.

### 4.4 OCR

Scroll to **Read an ID image**, pick a clear photo of a PAN card or marksheet,
and press **Read text**.

The first run loads about 7 MB of WebAssembly and language data from local disk
and takes a few seconds — the progress bar tracks the real phases. Later runs are
fast.

**Verify it stays offline — this is the claim that matters.** Before pressing the
button, open **F12 → Network** and filter by `tesseract`. Every request must be a
`chrome-extension://` URL. If you see `cdn.jsdelivr.net`, one of the three path
overrides has been lost — see [vendor/README.md](vendor/README.md).

Suggestions are editable and individually tickable. **Apply** only fills the form
above; you still have to press **Save vault**.

### 4.5 Idle auto-lock

1. In **Settings**, set auto-lock to **1** minute and press **Save settings**.
2. Close the options tab and leave the browser alone for just over a minute.
3. Open the popup. It should say **Locked**, with Fill disabled.

Set it back to something practical afterwards.

### 4.6 Backup and restore

1. **Backup → Export encrypted backup.** A `.formpilot-backup` file downloads.
2. Open it in a text editor. It should be JSON containing `kdf`, `iv` and
   `ciphertext` — and none of your actual data in readable form.
3. To test recovery: **Forgot passphrase? → type DELETE** to wipe the vault, then
   **Import and replace** with your backup file, and unlock with the passphrase
   that backup was taken under.

---

## 5. Automated checks

```bash
npm test
```

or, with no npm:

```bash
node test/run.mjs
```

Expected:

```
  ok   crypto   23 passed, 0 failed    PBKDF2 + AES-GCM, IV uniqueness, tamper detection
  ok   match    41 passed, 0 failed    field inference, specificity, refusal cases
  ok   image    19 passed, 0 failed    file-size band search, ladder descent, failure modes
  ok   ocr      25 passed, 0 failed    PAN / date / Aadhaar / name-line heuristics
  ok   backup   24 passed, 0 failed    export-import round trip, malformed-file rejection

All suites passed — 132 assertions.
```

Run one suite on its own to see every assertion:

```bash
node test/crypto.test.mjs
```

**What these cover:** the pure logic — cryptography, field matching, the image
band search, OCR text heuristics, backup envelopes — under Node's Web Crypto,
which is the same API the browser provides.

**What they cannot cover:** anything DOM- or Chrome-shaped — script injection,
the React value-setter path, Shadow DOM, canvas encoding, WebAssembly
instantiation, alarms, session storage. That is what step 4 is for.

---

## 6. The development loop

After editing any file:

1. Go to `chrome://extensions`.
2. Click **↻** on the FormPilot card.
3. Reload any open options tab, and close and reopen the popup.

**A manifest change always requires the reload.** So does a service-worker
change. JavaScript and CSS changes usually do too — reload anyway, it costs a
second.

Where the consoles live:

| Context | How to open it |
|---|---|
| **Options page** | F12 on the tab |
| **Popup** | Right-click *inside* the popup → **Inspect**. A normal click elsewhere closes the popup, which is what makes popup debugging fiddly. |
| **Service worker** | The **service worker** link on the extension card |
| **Content script** | F12 on the web page being filled — it logs into the page's own console |

Run `npm test` after touching anything in `lib/`.

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Card says **service worker (Inactive)** | Normal. MV3 workers sleep when idle and wake on an event. Not a fault. |
| **"Manifest is not valid JSON"** | A trailing comma or a comment in `manifest.json`. It must be strict JSON. |
| Popup opens but **Fill is greyed out** | The vault is locked, or the tab is a restricted page. Unlock via **Open vault**. |
| **"Chrome does not allow extensions to run on this page"** | You are on `chrome://`, the Web Store, or a PDF viewer. Chrome blocks these for every extension. Try an ordinary site. |
| Fill works on http sites but not a **local file** | `file://` pages need it explicitly: extension card → **Details** → **Allow access to file URLs**. Or serve over `python3 -m http.server`. |
| **Filled 0 of N** on a real form | The site's field names did not match. Use **Teach** to map them once. |
| Fields fill then **immediately clear** | A framework is rejecting the value. `content.js` already uses the native prototype setter for this; if it still happens, report the site. |
| OCR: **"OCR failed"** | Open the console. If it names a `cdn.jsdelivr.net` URL, a path override was lost. If it mentions WebAssembly or CSP, `'wasm-unsafe-eval'` is missing from `content_security_policy` in the manifest. |
| OCR is **slow the first time** | Expected — ~7 MB of WASM and language data loading from disk. It is cached afterwards. |
| **"Out of storage"** on save | `chrome.storage.local` holds ~10 MB. Compress images with the **Image tool** before saving them, or delete a document. |
| Vault **locked itself** while you were working | The idle auto-lock fired. Raise the timeout in **Settings**. |
| **Forgot the passphrase** | The data is unrecoverable by design. Restore a backup, or **Forgot passphrase? → DELETE** and start over. |

---

## 8. Installing it somewhere else

There is no Web Store listing, so every machine loads it unpacked via step 2.

To move it:

```bash
zip -r formpilot.zip . -x '.git/*' 'node_modules/*' '*.formpilot-backup'
```

Unzip on the other machine and load unpacked there.

Your vault does **not** travel with the folder — it lives in Chrome's profile
storage, not in these files. To move your data, use **Export encrypted backup**
on the old machine and **Import and replace** on the new one.

`package.json` exists only so Node can run the test suite as ES modules. Chrome
ignores it entirely.

---

## Where to read next

| File | What it covers |
|---|---|
| [README.md](README.md) | What FormPilot is, features, the privacy model |
| [CLAUDE.md](CLAUDE.md) | Project rules — the constraints any change must respect |
| [PLAN.md](PLAN.md) | The phase-by-phase build log and what each phase deferred |
| [DESIGN.md](DESIGN.md) | The UI design system and its tokens |
| [vendor/README.md](vendor/README.md) | Third-party code, why each override exists, how to verify it stays offline |
