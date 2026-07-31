# FormPilot — project rules

A local-first Chrome/Edge extension (Manifest V3): encrypted document vault +
intelligent form autofill + resize-to-portal-spec + OCR extract. No backend, no
accounts, works offline. Built in phases — see [PLAN.md](PLAN.md).

## Hard rules

These are not preferences. Breaking one is a bug, even if the feature works.

1. **Never auto-submit a form.** No `form.submit()`, no `.click()` on submit
   buttons, no Enter-key synthesis. The user reviews and submits, always.
2. **Never write plaintext personal data to disk.** Anything personal reaches
   `chrome.storage.local` only via `encryptVault()` in `lib/crypto.js`. Exactly
   three unencrypted keys exist, and adding a fourth needs a good reason:
   - `session.vaultData` — decrypted text fields while unlocked, so the popup
     can fill forms. `chrome.storage.session` is **memory-only, never written to
     disk**, and pinned to `TRUSTED_CONTEXTS` so content scripts cannot read it.
     Cleared on Lock and on browser restart. Documents are excluded.
   - `local.settings` — UI preferences. No personal data.
   - `local.siteMappings` — `hostname → { cssSelector: vaultFieldName }`. Field
     *names*, never values. Unencrypted because the popup must read it while the
     vault may be locked; the hostnames it reveals are already in your browser
     history.
3. **Never fill password fields.** Skip `input[type=password]` in autofill.
4. **No network. Ever.** No `fetch`, no CDN, no analytics, no telemetry. If a
   feature seems to need the network, it is the wrong feature.
5. **No remote code (MV3 requirement).** Third-party libraries get vendored into
   `/vendor` and referenced by local path. Set `corePath`/`workerPath`/`langPath`
   at local files.
6. **Vanilla JS + HTML + CSS.** No frameworks, no bundler, no build step, no
   runtime npm dependencies. It must load unpacked exactly as it sits on disk.

## Crypto invariants

- PBKDF2-SHA256 → AES-256-GCM. Parameters live in `lib/crypto.js`.
- **A fresh random IV on every single save.** Reusing an IV under one key breaks
  GCM outright. `encryptVault()` generates one per call — never pass one in.
- The salt is per-vault, random, stored in the clear, and never changes.
- Derived keys are `extractable: false` and live only in page memory. They are
  never written to storage, never logged, never passed in messages.
- No stored password hash — a failed decrypt *is* the wrong-passphrase signal.
- Store the minimum: Aadhaar is reduced to its last 4 digits *before* it reaches
  the vault object, not at display time.

## Platform gotchas

- **The service worker is ephemeral.** It sleeps and wipes its globals. Keep
  state in `chrome.storage`, not module-level variables in `background.js`.
- **Contexts cannot call each other.** Popup, options, content script and worker
  talk via `chrome.runtime.sendMessage` / `chrome.tabs.sendMessage`.
- **After setting a field's value, dispatch `input` and `change`** or React/Vue
  sites ignore the fill.
- **No inline `<script>`** — MV3 CSP forbids it. External files only.
- **Never `innerHTML` with vault data.** Extension pages are privileged; use
  `textContent` and `createElement`.
- `chrome.storage.local` is ~10 MB. Images are the only thing that will ever
  threaten that.

## Layout

```
manifest.json     background.js (service worker)
popup.html/js     options.html/js   (vault + image tool + OCR)
content.js        (field detection + fill; injected on demand, not declared)
lib/              crypto.js, match.js, image.js, ocr.js
vendor/           third-party libs, local copies only
icons/
```

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
