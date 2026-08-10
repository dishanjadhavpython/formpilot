# Store listing copy

Paste-ready text for Edge Add-ons and the Chrome Web Store. Both take the same
package; only the forms around them differ.

**Launch on Edge first.** It is free to publish on — Chrome's US$5 is a Chrome
cost, not an extension cost — so nothing below has to wait on that fee. See
[CHECKLIST.md](CHECKLIST.md) steps 4 and 5.

**The positioning decision behind all of this:** FormPilot is not "another
autofill extension". Framed generically it competes with Chrome's built-in
autofill and every password manager, and loses, because they sync and it
deliberately does not. Framed as *the tool for Indian exam and government portal
applications* it has no real competitor — nothing else pairs KB-band image
resizing with Aadhaar-aware form filling and an offline guarantee. Every line
below leads with that.

---

## Name

```
FormPilot — offline form filler & photo resizer
```

Chrome allows 75 characters, Edge 50. If the Edge field truncates, use:

```
FormPilot — offline form filler
```

## Short description (132 characters max, both stores)

Chrome shows this in search results, so it carries more weight than the long
description. 129 characters:

```
Fill exam and government portal forms from an encrypted local vault. Resize photos to an exact KB range. Fully offline.
```

## Category

- **Chrome:** Workflow & Planning (not Productivity — less crowded, better fit)
- **Edge:** Productivity
- **Language:** English (add Hindi and Marathi listings in Phase 10)

---

## Detailed description

```
Applying through an Indian government or exam portal means typing the same
twenty fields again, and again, and again — then discovering your photograph
must be a JPEG between 20 KB and 50 KB, and the compressor you found online
returned a 6 KB file that the portal rejected just as firmly as the 4 MB one.

FormPilot fixes both halves of that afternoon, and never sends any of it
anywhere.


FILLS THE FORM

Store your details once — name, date of birth, phone, address, PAN, Aadhaar
(last four digits only), several labelled email addresses, and any custom
fields you need. FormPilot works out what each box on a page is asking for from
its label, not from a list of supported websites, so it works on portals nobody
has ever written an integration for.

It also knows what NOT to fill:

  • It never submits a form. You review and submit, always.
  • It never fills a password field.
  • It never overwrites something you already typed.
  • It never puts your details in somebody else's box — "Father's Name",
    "Spouse Email", "Nominee", "Emergency Contact" are left alone unless you
    explicitly labelled a value for that person.
  • It refuses OTP and captcha fields, which need a human by definition.

Got one wrong? Teach it: click the field, say what it is, and FormPilot
remembers it for that site.


RESIZES THE PHOTO TO THE EXACT SPEC

"JPEG, maximum 600 pixels, between 20 KB and 50 KB."

Ordinary compressors aim at the maximum and ignore the minimum, which is why
they hand back a file that gets rejected for being too small. FormPilot
searches for a result inside the whole range. When a range genuinely cannot be
hit, it tells you which end failed instead of returning something that will
bounce.

Three presets — passport photo, signature, document scan — plus custom specs
you can save.


READS YOUR ID CARDS

Point it at a PAN card, an Aadhaar card or a marksheet and it suggests values
for your fields, with a confidence score. Every suggestion is editable and
individually tickable. Nothing is saved until you say so. The recognition runs
on your own device.


ENCRYPTED, AND GENUINELY OFFLINE

Your vault is encrypted with AES-256-GCM under a key derived from your
passphrase with PBKDF2-SHA256 (310,000 iterations). The key is non-extractable,
lives only in memory, and is never written to disk. The vault locks itself
after five minutes idle and whenever you close the browser.

FormPilot makes no network requests of any kind. No account, no server, no
sync, no analytics, no telemetry, no crash reporting. There is nothing to opt
out of, because there is nothing to opt out from. Turn off your Wi-Fi and every
feature still works.

You do not have to take that on faith. Open DevTools, watch the Network tab,
and use the whole extension — every request you see should be a
chrome-extension:// URL. The source is public, and because FormPilot has no
build step, the code you can read is byte-for-byte the code that runs. Each
release publishes a checksum so you can prove it.


WHAT IT ASKS FOR

FormPilot does not request access to your websites when you install it. Filling
runs on the tab you are looking at, when you click. If you want it to notice
forms on its own and offer, you turn that on in Settings and the browser asks
you then — and turning it back off gives the access straight back.


TRY IT BEFORE YOU TRUST IT

Installing opens a sample form filled with made-up details. No passphrase, no
data, nothing saved — just a look at what it does, including everything it
refuses to touch.


LIMITATIONS, STATED HONESTLY

  • OCR is English-only, and works best on a flat, well-lit photo.
  • Checkboxes, radio buttons and forms inside iframes are not filled yet.
  • The image tool scales but does not crop, so a spec demanding an exact
    aspect ratio (3.5 × 4.5 cm) needs cropping elsewhere first.
  • Uploads are matched for images — photo, signature, PAN, Aadhaar, ID proof.
    PDF uploads are not supported.
  • There is no way to recover a forgotten passphrase. That is what the
    encryption is for.

Free, open source (MIT), no ads, no paid tier, nothing to sign up for.
```

**Length check:** ~3,400 characters. Chrome's limit is 16,000, Edge's 10,000 —
comfortable in both.

---

## Privacy fields (Chrome Web Store)

**Single purpose** — one sentence, and reviewers reject vague answers:

```
FormPilot fills web forms from an encrypted vault of the user's own details and
documents stored locally on their device.
```

**Data usage declarations.** Tick nothing. FormPilot collects no data of any
kind. When the form asks you to certify each of these, all three are true:

- ☑ I do not sell or transfer user data to third parties, outside of approved use cases
- ☑ I do not use or transfer user data for purposes unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL** — must be publicly reachable before you submit:

```
https://dishanjadhavpython.github.io/formpilot/privacy
```

Set this up first: repository **Settings → Pages → Deploy from branch → main**,
then confirm the URL loads in a private window. A 404 here is a rejection.

**Permission justifications:** see [permissions.md](permissions.md).

---

## Edge Add-ons differences

Same package, same copy, and the store to launch on. What differs from the
Chrome forms described above:

- **No developer registration fee at all.** A Microsoft account is the only
  requirement.
- Category is **Productivity** (Edge has no "Workflow & Planning").
- Asks for a **"Why do you need this permission?"** note per permission — reuse
  [permissions.md](permissions.md) verbatim.
- Wants a **support contact URL**: use the GitHub issues page.
- Screenshot requirement is 1280×800 or 640×400, same as Chrome, so one set
  covers both stores.
- Review is typically faster than Chrome's.

One line worth adding to the Edge description, because Edge users are used to
being an afterthought:

```
Works the same on Edge as on any Chromium browser — this is not a port, it is
the same package.
```

---

## Two things to get right

**Do not claim "no data collected" in the description while the manifest asks
for anything that contradicts it.** It does not, but a reviewer checks. The
optional-permission model in `manifest.json` is what makes this consistent, so
do not move `<all_urls>` back to `host_permissions` to simplify a rejection —
that would create the contradiction rather than resolve it.

**Do not describe FormPilot as a password manager.** It never touches password
fields by design, and that category carries extra review requirements you have
no reason to invite.
