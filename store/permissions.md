# Permission justifications

Both stores ask, per permission, why the extension needs it. These are the
answers. They are short on purpose — a reviewer is reading dozens of these, and
a justification that argues is worse than one that states.

Every answer below is checkable against the source, which matters: a
justification that does not match the code is the fastest route to a rejection.

---

### `storage`

```
Stores the user's encrypted vault and their preferences on their own device.
Nothing is transmitted; the extension makes no network requests at all.
```

### `activeTab`

```
Reads the fields of the tab the user is looking at, and fills them, when the
user clicks Fill or presses the keyboard shortcut. Grants access to that one
tab only, at the moment the user acts.
```

### `scripting`

```
Injects the form-detection and filling script into that tab on demand. The
content script is not declared in the manifest, so it never runs on a page
unless the user asked for it.
```

### `alarms`

```
Runs the idle countdown that locks the vault automatically after a period of
inactivity. A service worker is terminated when idle, so the timer cannot live
in the worker itself.
```

### `<all_urls>` — declared as **optional**, not requested at install

```
Only requested if the user switches on "Offer to fill when a form is detected",
which scans pages as they load to show how many fields could be filled. It is
declared under optional_host_permissions, so a normal install requests no site
access at all, and switching the setting off revokes it again. Filling on click
does not use it — that runs on activeTab.
```

> Reviewers pay particular attention to broad host access. The wording above is
> worth keeping close to verbatim: the fact that the permission is *optional*
> is the whole justification, and it is easy to lose by paraphrasing.

---

## Remote code declaration

Chrome asks whether the extension executes remote code. **The answer is no**,
and the confusing part is `'wasm-unsafe-eval'` in the manifest CSP. Expect this
to be queried; the answer:

```
No remote code. The extension bundles every dependency locally and its CSP
pins connect-src to 'self', so it cannot load code from anywhere.

The 'wasm-unsafe-eval' directive is required by Chrome to instantiate a
WebAssembly module, and the module in question is the OCR engine
(tesseract.js), which is vendored inside the package under vendor/tesseract/
and configured with explicit local paths for its worker, its WASM core and its
language data. Despite the name, 'wasm-unsafe-eval' does not permit eval() or
the loading of remote scripts.
```

## If a reviewer asks why an offline extension needs host access at all

```
It does not, for its main feature. Filling a form runs on activeTab, granted
when the user clicks the toolbar icon or presses the shortcut.

Host access is only used by the optional "notice a form and offer to fill it"
setting, which has to look at pages as they load in order to notice anything.
That is why it is an optional permission the user grants deliberately, rather
than a required one everybody accepts at install.

Host access is never used to send anything anywhere. The extension contains no
networking code, and its CSP blocks a request at the browser level.
```

## If a reviewer asks about Aadhaar / sensitive identity data

```
Aadhaar numbers are reduced to their last four digits before they are ever
stored — the masking happens at input, not at display, so the full number is
never written anywhere. This follows UIDAI guidance to mask by default and
store the minimum.

All vault data, including document images, is encrypted at rest with
AES-256-GCM under a PBKDF2-SHA256 key derived from the user's passphrase. The
key is non-extractable and exists only in page memory. Nothing is transmitted
off the device, and there is no server to transmit it to.
```

---

## Sanity check before submitting

Run this and confirm the output still matches the justifications above:

```bash
node -e "const m=require('./manifest.json'); console.log(JSON.stringify({
  permissions: m.permissions,
  host_permissions: m.host_permissions,
  optional_host_permissions: m.optional_host_permissions,
  content_scripts: m.content_scripts,
  web_accessible_resources: m.web_accessible_resources
}, null, 2))"
```

Expected: four permissions, `host_permissions` **undefined**,
`optional_host_permissions` exactly `["<all_urls>"]`, and both
`content_scripts` and `web_accessible_resources` undefined. `npm test` asserts
all of that too, but check it by eye before an upload you cannot take back.
