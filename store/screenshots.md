# Screenshot shot list

Five screenshots, in this order. **Order is the whole point**: the first one is
the only one most people see, and it decides whether they read anything else.

**Specification (both stores):** 1280×800 PNG, no rounded corners, no drop
shadows, no device frames. Chrome crops anything else awkwardly.

---

## Why the resize shot goes first

The instinct is to lead with the vault, because the vault is the impressive
engineering. Resist it. A vault screenshot looks exactly like every password
manager's vault screenshot, and viewers pattern-match it to "another password
manager, I have one".

The KB-band resize is the only thing in FormPilot that nobody else does, and it
is legible in about two seconds: a big number becomes a small number, inside a
range the portal demanded. Lead with the thing that is both unique and instantly
understandable.

---

## 1 — The resize, mid-success

**Capture:** the Image tool section, after compressing a large photo into a
20–50 KB band.

Set it up so the numbers are dramatic and true:

- Use a real phone photo, 3–5 MB, 4000px on the long edge.
- Choose the passport-photo preset, or a custom spec of 20–50 KB / 600px.
- Wait for the result panel: original size, result size, percent saved,
  dimensions, quality, encode count.

**Must be visible:** the before size, the after size, the target range, and the
"saved %" figure. If the result lands at 47 KB inside a 20–50 KB band, that one
line does more selling than the rest of the listing.

**Caption:** `A 4 MB photo, into the exact range the portal demanded.`

## 2 — A form being filled

**Capture:** a real-looking application form immediately after a fill, with the
filled fields outlined in blue and the "Filled 11 of 20" status visible.

Use the bundled demo — open `demo.html` from the extension and click Fill. It is
built for exactly this: twenty fields, realistic labels, and a result panel that
already reads well.

**Must be visible:** several filled fields with their blue outlines, and the
count. Scroll so at least one refused field is in frame if you can.

**Caption:** `Understands the labels. Fills what it should.`

## 3 — What it refuses

**Capture:** the demo's result panel, scrolled to the refusal list — password,
already-filled, Father's Name, Emergency Contact, OTP, captcha, each with its
reason.

This is the trust shot, and it is the one that will surprise people. Nobody
expects an autofill tool to advertise what it won't do.

**Caption:** `It leaves nine of twenty alone, on purpose — and says why.`

## 4 — OCR reading an ID

**Capture:** the "Read an ID image" panel after recognising a PAN card, showing
the extracted fields with confidence scores and their tick boxes.

**Use a fake card.** Do not photograph your own PAN or Aadhaar and upload it to
a public store listing. Make a mock-up with plausible but invented values, or
blur every real digit. This is the single easiest mistake to make in this whole
phase and it is not undoable once the listing is live.

**Caption:** `Reads the card. Suggests, never saves.`

## 5 — The vault, locked

**Capture:** the options page in its locked state, plus the Settings section
showing the auto-lock timeout.

Locked rather than unlocked, for two reasons: no personal data can leak into the
image, and "this thing locks itself" is the message worth leaving people with.

**Caption:** `Encrypted on your device. Locks itself. No account, ever.`

---

## Before you upload any of them

- [ ] No real name, phone number, address, PAN, Aadhaar or email anywhere in
      any frame. Check the browser's autofill dropdowns and the tab titles too.
- [ ] No other browser tabs showing anything identifiable.
- [ ] No bookmarks bar.
- [ ] Taken at 1280×800 exactly — resize the window, do not scale afterwards.
- [ ] Light mode. Dark screenshots read as muddy at listing thumbnail size.
- [ ] Zoom at 100%.

A clean way to get all of that: a fresh browser profile with only FormPilot
installed, window sized to 1280×800, bookmarks bar hidden.

---

## Promo tile (440×280)

Chrome shows this in category browsing and the "similar extensions" strip. It is
optional, and an ugly one is worse than none.

[`promo-tile.html`](promo-tile.html) is the source. Open it in the browser and
screenshot the bordered box exactly, or from the DevTools device toolbar set a
440×280 viewport and capture. It deliberately shows the one number that is worth
440 pixels of anybody's attention.
