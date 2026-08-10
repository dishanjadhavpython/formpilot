# FormPilot — Privacy Policy

**Last updated:** 11 August 2026
**Applies to:** the FormPilot browser extension, all versions.

## The short version

FormPilot collects nothing, transmits nothing, and stores nothing anywhere
except your own browser profile on your own device.

There is no server to send data to. There is no account to create. There is no
analytics, no telemetry, no crash reporting, and no advertising identifier.
This is not a policy choice that could be reversed in an update — the extension
contains no networking code at all, and its Content Security Policy
(`connect-src 'self'`) blocks the browser from making one even if code tried.

Because nothing is collected, there is nothing to opt out of, nothing to
request a copy of, and nothing to ask us to delete.

## What FormPilot stores, and where

Everything below lives in your browser's local extension storage, on your
device. None of it is uploaded, synced, backed up to a cloud, or shared with
the developer or any third party.

| What | Where | Encrypted? |
|---|---|---|
| Your personal details (name, date of birth, email addresses, phone, address, PAN, masked Aadhaar, custom fields) | `chrome.storage.local` | **Yes** — AES-256-GCM |
| Your document images (photo, signature, ID cards, marksheets) | `chrome.storage.local` | **Yes** — AES-256-GCM |
| Your preferences (auto-lock timeout, highlight toggle, saved image presets) | `chrome.storage.local` | No — contains no personal data |
| Site field mappings you taught (`hostname → { css selector: field name }`) | `chrome.storage.local` | No — stores field *names*, never values |
| Your decrypted details, only while the vault is unlocked | `chrome.storage.session` | Memory only — **never written to disk** |

The session copy exists so the popup can fill a form without asking for your
passphrase again. It is held in memory, is unreadable by web pages, and is
erased when you lock the vault, when the idle timer fires, and when you close
the browser.

## Encryption

- Your passphrase is stretched into a 256-bit key using **PBKDF2-SHA256** with
  310,000 iterations against a random per-vault salt.
- The vault is encrypted with **AES-256-GCM**, using a fresh random
  initialisation vector on every single save.
- The derived key is non-extractable and exists only in the memory of the
  options page. It is never written to disk, never logged, and never included
  in any message.
- No password hash is stored. A failed decryption *is* the wrong-passphrase
  signal.

**Nobody can recover your passphrase — including the developer.** There is no
reset, no recovery email, and no backdoor. If you forget it, the encrypted data
is unrecoverable. That is what the encryption is for.

## What web pages can see

FormPilot injects a script into a page in order to find and fill form fields.
That script is deliberately kept ignorant:

- When detecting or planning a fill, the page's script receives only the
  **names** of the fields your vault can answer (`email`, `phone`) and the
  **types** of documents it holds (`signature`, `pan`) — never a value, never
  an image.
- Real values and images are sent only in the final fill message, only for the
  specific fields that fill is about to write, and only after you click.
- Password fields are never filled. Forms are never submitted for you.

## Permissions and why each exists

| Permission | Why |
|---|---|
| `storage` | To keep your encrypted vault and preferences on your device |
| `activeTab` | To read and fill the fields of the tab you are on, when you click Fill |
| `scripting` | To inject the fill script into that tab on demand |
| `alarms` | To run the idle auto-lock countdown |
| `<all_urls>` (optional) | Only requested if you turn on "Offer to fill when a form is detected". Declined or revoked, FormPilot still fills forms when you click. |

FormPilot does not request access to your browsing history, cookies, downloads,
bookmarks, or network requests.

## Children

FormPilot is a general-purpose utility and is not directed at children under
13. It collects no data from anyone, of any age.

## Third-party code

Two open-source libraries are bundled inside the extension:
`browser-image-compression` (image resizing) and `tesseract.js` (OCR). Both are
shipped as local copies and audited to confirm they make no network requests at
runtime — see [`vendor/README.md`](vendor/README.md). Optical character
recognition runs entirely on your device; no image is ever uploaded anywhere.

## Verifying all of this yourself

You do not have to take any of it on trust:

1. Open the FormPilot options page, open DevTools, and select the Network tab.
2. Use every feature — save the vault, resize an image, run OCR, fill a form.
3. Every request you see should be a `chrome-extension://` URL. There should be
   no request to any other host, at any time.

To confirm your data is encrypted at rest, run this in the extension's console:

```js
chrome.storage.local.get('vault', console.log)
```

No readable personal value should appear anywhere in the output.

The full source is published, and the extension ships with no build step, so
the code you can read is exactly the code that runs.

## Changes to this policy

Any change will be published in this file in the public repository, with the
"Last updated" date above revised. Because the extension has no network access,
a change to its data practices would require a new version, reviewed and
installed through the browser's extension store.

## Contact

Questions about privacy, or a suspected vulnerability:
**dishanjadhav0827@gmail.com**

For security reports specifically, see [`SECURITY.md`](SECURITY.md).
