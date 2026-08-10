# Security

FormPilot holds a scan of your PAN card and your home address. This document
says plainly what protects that, what does not, and how to check for yourself.

Run the checks:

```bash
npm test            # everything, 334 assertions
npm run security    # what crosses into a web page; hostile-file handling
npm run audit       # static scan of the source against the rules below
npm run audit:verify  # proves the audit catches real regressions
```

---

## What we are defending against

Ranked by how likely it is to actually happen to you.

| # | Threat | Status |
|---|---|---|
| 1 | A **website** reads your vault, or fills itself from it | Blocked — see [What a web page can reach](#what-a-web-page-can-reach) |
| 2 | Someone with your **unlocked laptop** opens the vault | Slowed — idle auto-lock, unlock throttling |
| 3 | Someone copies the **vault file off the disk** | Blocked by AES-256-GCM, as strong as your passphrase |
| 4 | Another **extension** talks to FormPilot | Blocked — `externally_connectable: {"ids": []}` |
| 5 | A **hostile backup file** weakens or wedges the vault | Blocked — every field validated before import |
| 6 | A **form** tricks the extension into revealing you are a bot | Blocked — honeypot detection |
| 7 | A **form** gets submitted without you reading it | Structurally impossible — nothing can submit |
| 8 | Data leaves the device to a **server** | Structurally impossible — no network code, CSP-enforced |

Explicitly **not** defended against — see [What this cannot protect you from](#what-this-cannot-protect-you-from).

---

## What a web page can reach

This is the part that matters most, because it is the only place hostile code
routinely meets your data. FormPilot runs a content script inside web pages, and
a content script is one bug away from the page it lives in.

So the rule is: **a page is told what the vault can answer, never what the
answer is.**

### Detection carries key names only

When you open a page while unlocked, the service worker asks the content script
how many fields it could fill. That message goes to **every http(s) page you
open**, so it carries this:

```js
{ keys: ['fullName', 'email', 'phone', 'custom:Employee ID'],
  emails: [{ label: 'work' }],
  customFields: [{ label: 'Employee ID' }] }
```

and never this:

```js
{ fields: { fullName: 'Dishan Jadhav', phone: '9876543210', ... } }   // no
```

Knowing that `phone` *has* a value is enough to count a phone field. The number
itself stays in the extension. `describeVault()` in [lib/match.js](lib/match.js)
and `publicMeta()` in [background.js](background.js) are the two functions that
enforce this, and `npm run security` greps a fully populated payload for every
value in a test vault to prove none of them appear.

### Filling hands over only what it is about to type

A fill is two messages, and the split is the point:

1. **PLAN** — sent with key names only. The page answers "I would fill these
   four keys."
2. **FILL** — sent with the values for *those four keys*.

So a page with one email box receives one email address. Not the address book,
not the phone number, not the PAN. The end-to-end harness demonstrates this
concretely: filling the test fixture withholds `custom:Employee ID`, because the
fixture has no field for it.

The plan is recomputed during the fill rather than trusted from before, so a page
that changes between the two messages cannot get a value written somewhere it was
not planned.

### The page cannot drive the extension

| Attack | Defence |
|---|---|
| Reach into the suggestion chip and click **Fill** | The in-page UI is a **closed** shadow root — `host.shadowRoot` is `null` for the page |
| Fire a synthetic click at the Fill button anyway | The handler requires `event.isTrusted`; `.click()` and `dispatchEvent()` both produce `false` |
| Send FormPilot a message pretending to be the popup | Both listeners check `sender.id === chrome.runtime.id` |
| Keep the vault unlocked by sending `ACTIVITY` forever | `ACTIVITY` is refused unless the sender is an extension page with no `tab` |
| Ask for every key at once | `REQUEST_FILL` requires an http(s) tab, an unlocked vault, suggestions on, and caps at 60 keys |
| Load an extension page in an iframe and read it | No `web_accessible_resources`, so no page can load anything of ours |

### Nothing runs unless you are unlocked

The content script is **not declared in the manifest**. It is injected
programmatically, and only when all three of these hold:

1. the page is `http(s)` — never `chrome://`, never the Web Store;
2. **the vault is unlocked**;
3. the *Offer to fill when a form is detected* setting is on.

Lock the vault and the extension stops touching web pages entirely.

---

## Encryption

- **PBKDF2-SHA256, 310,000 iterations**, against a random 16-byte per-vault salt.
- **AES-256-GCM**, with a **fresh random IV on every single save**. Reusing an IV
  under one key breaks GCM outright; `encryptVault()` generates its own and
  accepts no IV parameter, so a caller cannot supply a stale one.
- The derived key is **non-extractable** and exists only in the memory of the page
  that unlocked it. `crypto.subtle.exportKey` on it throws — there is a test.
- **No stored password hash.** A failed decryption *is* the wrong-passphrase
  signal, so there is nothing to attack offline but the ciphertext itself.
- Aadhaar is reduced to its **last four digits before it reaches the vault**, not
  at display time.

Three keys are stored **unencrypted**, and adding a fourth is a decision, not a
diff — the audit fails if one appears:

| Key | Contents | Why it is safe |
|---|---|---|
| `local.settings` | Auto-lock minutes, toggles, image presets | No personal data |
| `local.siteMappings` | `hostname → { selector: field name }` | Field *names*, never values. The hostnames are already in your history |
| `session.vaultData` | Text fields, while unlocked | `chrome.storage.session` is **memory-only, never written to disk**, pinned to `TRUSTED_CONTEXTS` so content scripts cannot read it, and cleared on lock and browser restart. Documents excluded |

---

## Guessing the passphrase

PBKDF2 costs about a quarter-second per attempt, which is the real defence
against an attack on the ciphertext. Unlock attempts are additionally throttled
for the other case — someone sitting at your unlocked machine:

| Failed attempts | Wait before the next try |
|---|---|
| 1–3 | none (typos should be free) |
| 4 | 2s |
| 5 | 4s |
| 6 | 8s |
| 7 | 16s |
| 8+ | 30s |

The counter lives in `chrome.storage.session`, so closing the tab is not a reset,
a browser restart is, and it can never lock you out permanently.

---

## Hostile files

An imported backup arrives from outside. Every field is checked before it is
written to storage, because a bad record is not merely invalid — it is a working
attack:

| Crafted value | What it would do | Result |
|---|---|---|
| `iterations: 1` | Restores a vault with effectively no key stretching, while the UI still says "encrypted" | Refused below 150,000 |
| `iterations: 2000000000` | Freezes the browser for minutes on every unlock | Refused above 4,000,000 |
| `kdf.name: "scrypt"` | Algorithm we do not implement | Refused |
| `kdf.hash: "SHA-1"` | Downgrade | Refused |
| A 20 MB ciphertext | Fills the ~10 MB quota so the real vault can no longer be saved | Refused above 12 MB |
| A 4-byte IV | Not our format; GCM is defined around 96 bits | Refused unless exactly 12 bytes |
| `ciphertext: "not base64!"` | Throws deep inside `atob()` at unlock time, long after a clear error was possible | Refused |

The record **already in storage** gets exactly the same scrutiny before a
passphrase is fed to it. The file on disk is not more trustworthy than the file
on the USB stick; it just arrived earlier.

---

## No network, enforced twice

Hard rule 4 is "no network, ever." It is enforced in two independent ways:

1. **Nothing in the source makes a request.** `npm run audit` fails on `fetch`,
   `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource`, `importScripts`,
   or any remote URL in first-party code.
2. **The CSP forbids it.** `connect-src 'self'` means the browser itself blocks
   any request to anything but the extension's own files — including from
   vendored library code we did not write.

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
connect-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline';
font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none';
form-action 'none'
```

`'wasm-unsafe-eval'` is required by the OCR engine's WebAssembly. Despite the
name it does **not** permit `eval()` or remote code.

Verify it yourself: open DevTools → Network on the options page and use every
feature, including OCR. Every request should be a `chrome-extension://` URL.

---

## The checks

| Suite | What it does | Assertions |
|---|---|---|
| `security.test.mjs` | Runs the code: what crosses into a page, hostile files, the worker's release gate | 88 |
| `audit.test.mjs` | Reads the source and asserts the rules above are still true of the file on disk | 74 |
| `audit-mutations.mjs` | Breaks 14 security properties one at a time and checks the audit notices | 14 |

The third one exists because **a check that cannot fail is worse than no check**:
it reports green forever and buys false confidence. It copies the project to a
temp directory, applies a real regression somebody could plausibly write — "just
this one fetch", "the shadow root needs to be open so I can debug it", "1000
iterations is faster in development" — and fails if the audit does not catch it.

Add a mutation whenever you add a check, or the check is decoration.

### What the checks cannot cover

They run under Node. They do not exercise the DOM, Chrome's APIs, WebAssembly, or
the real CSP. Those were verified separately in headless Chrome, and the results
are recorded here rather than re-derived:

- The manifest and CSP are accepted by Chrome's own validator (`--pack-extension`
  refuses `'unsafe-eval'`, and accepts what ships).
- Both extension pages load under the shipped CSP with zero violations.
- The real `content.js`, driven against `test/form.html`, detects 12 fields
  without touching the page, fills exactly those 12, and violates none of the
  10 must-stay-empty safety cases.

---

## What this cannot protect you from

Being honest about the edges is part of the security model.

- **Malware on your computer.** Anything that can read Chrome's profile, log your
  keystrokes, or attach a debugger has already won. Local-first means locally
  trusted.
- **A weak passphrase.** 310,000 PBKDF2 rounds multiply the cost of each guess;
  they do not rescue `password123`. Use several random words.
- **The site you fill.** Once a value is in a form field, that site has it. That
  is what filling a form means. FormPilot decides *what* to type and *where*; it
  cannot decide what the site does next.
- **A malicious extension with its own permissions.** Extensions cannot read each
  other's storage, but one with `<all_urls>` can read a page after you fill it.
- **Losing your passphrase.** There is no reset, no recovery, no backdoor. Keep an
  exported backup.
- **Physical access to an unlocked vault.** Auto-lock helps; it is not a safe.
- **A supply-chain attack on the vendored libraries.** They are pinned, hashed and
  audited by hand in [vendor/README.md](vendor/README.md), and `connect-src 'self'`
  stops them phoning home — but they are still third-party code.

---

## Reporting something

This is a personal project with no server, no user accounts and no telemetry, so
there is no fleet to patch and no incident response to run. What there is, once
this is on a store, is a population of people whose vaults are only as safe as
the last released version — which makes *how* a flaw arrives worth stating.

**If the flaw is exploitable, report it privately first.** Public disclosure of a
working attack on a vault means every installed copy is vulnerable from the
moment the issue is filed until a fixed version has been reviewed and rolled out,
and store review is not instant. Either route works:

- GitHub's **private vulnerability reporting** (Security → Report a vulnerability
  on the repository), or
- **dishanjadhav0827@gmail.com**

Expect an acknowledgement within a few days. A fix ships as fast as store review
allows, and you will be credited unless you would rather not be.

**Everything else — open an issue.** Hardening ideas, a rule in
[CLAUDE.md](CLAUDE.md) this code does not actually keep, a threat in the table
above that deserves a better answer. None of that needs to be private, and
discussing it in the open is how it gets better.

**Best of all, send a failing test.** Add the case to `test/security.test.mjs`
and a mutation to `test/audit-mutations.mjs`, and the flaw can never quietly come
back.

## Verifying a release

FormPilot has no build step, so a shipped copy should be byte-identical to its
tag. `npm run checksums` fingerprints every file that ships; the aggregate hash
is published with each release. See README.md, "Verify what you installed".
