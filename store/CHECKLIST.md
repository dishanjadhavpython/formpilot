# Launch checklist

Everything that can be prepared in the repository has been. What remains needs
an account, a card, a browser and your judgement — this is that list, in order.

Nothing here is reversible in the way code is. A published listing is public, a
screenshot containing a real Aadhaar number stays cached, and a version number
can never be reused. Work down the list rather than around it.

---

## 0 — Before anything else

- [ ] **Load the extension unpacked and use it for ten minutes.** Every browser-
      dependent thing in Phases 7 and 8 is verified by tests against stubs, not
      by a browser. Specifically confirm:
  - [ ] Clicking **Fill** works on a real form with detection switched **off**
        (this is the `activeTab`-only path — the main feature, and the one the
        permission change in Phase 7 touched).
  - [ ] Switching on "Offer to fill when a form is detected" shows Chrome's
        permission prompt, and detection starts working after you accept.
  - [ ] Switching it back off, then checking `chrome://extensions` shows site
        access has been given back.
  - [ ] `Ctrl+Shift+F` fills the current page. If it does nothing, check
        `chrome://extensions/shortcuts` — another extension may hold it.
  - [ ] A fresh profile opens the welcome page on install.
  - [ ] `demo.html` fills 11 of 20 and lists the 9 refusals with reasons.
  - [ ] The image tool hits a KB band on a real photo.
  - [ ] OCR reads a card and the results panel appears.
- [ ] `npm test` — all suites green.
- [ ] `chrome.storage.local.get('vault', console.log)` in the extension console
      shows nothing readable.

## 1 — Publish the privacy policy

The store will reject a submission whose privacy policy URL 404s, and it is the
slowest thing to notice because the rejection arrives days later.

- [ ] Repository **Settings → Pages → Deploy from branch → `main` → `/root`**
- [ ] Wait for the deploy, then open the URL **in a private window**
- [ ] Paste the working URL into [`listing.md`](listing.md) so it is recorded

## 2 — Tag the release

- [ ] `npm run checksums > /dev/null && npm run checksums --silent | tail -1`
      — note the aggregate hash
- [ ] `npm run package` — note the ZIP's sha256
- [ ] `git tag -a v1.0.0 -m "v1.0.0"` and push the tag
- [ ] Create a GitHub release for the tag, attach `dist/formpilot-1.0.0.zip`,
      and put **both** hashes in the release notes with a line pointing at
      README's "Verify what you installed"

The package is reproducible, so anyone can rebuild it and get the same bytes.
That claim is only worth making if the hash is actually published.

## 3 — Make the assets

- [ ] Five screenshots per [`screenshots.md`](screenshots.md), 1280×800 PNG
- [ ] Run its pre-upload checklist — **especially** the "no real identity data
      in any frame" line, including the OCR shot
- [ ] Promo tile from [`promo-tile.html`](promo-tile.html), 440×280

## 4 — Edge Add-ons (free — launch here)

**Microsoft charges no registration fee.** Chrome's US$5 is a Chrome cost, not
an extension cost, and nothing about it gates this store. Same ZIP, same copy,
same screenshots, and review is usually faster than Chrome's.

This is a real launch, not a consolation prize. Edge ships as the default
browser on every Windows machine — including a great many of the budget laptops
and shared cyber-café machines the exam-portal audience actually uses — and the
Edge store is far less saturated, so a new extension is genuinely more
discoverable there than it would be as one of thousands on Chrome.

- [ ] Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge)
      — free, needs only a Microsoft account
- [ ] New extension → upload `dist/formpilot-1.0.0.zip`
- [ ] Paste name, short description and detailed description from
      [`listing.md`](listing.md)
- [ ] Category **Productivity**, language **English**
- [ ] Upload the screenshots in the order given, and the promo tile
- [ ] Per-permission "why do you need this?" notes from
      [`permissions.md`](permissions.md) — verbatim, especially the
      `<all_urls>` one
- [ ] Privacy policy URL from step 1
- [ ] Support URL: the repository's issues page
- [ ] Submit

## 5 — Chrome Web Store (US$5, whenever you have it)

The fee is one-time, covers up to 20 extensions forever, and there is no waiver,
no student programme and no free tier. There is also no consumer-viable way
around it: Chrome blocks self-hosted `.crx` installs on Windows and macOS, so
"host it yourself" reaches nobody who is not already in developer mode.

So this step waits. Nothing is lost by waiting, and something is gained:
arriving at Chrome's stricter review with a live Edge listing, real install
numbers and a few reviews is a materially better position than arriving with
nothing.

- [ ] Register at the [developer dashboard](https://chrome.google.com/webstore/devconsole)
      — US$5, on a Google account you will still control in five years. Not a
      college address.
- [ ] Verify your email and publisher name. The publisher name is what users see
      under the extension title; it is worth a moment's thought.
- [ ] New item → upload the **same** `dist/formpilot-1.0.0.zip`
- [ ] Same copy from [`listing.md`](listing.md); category
      **Workflow & Planning**
- [ ] Same screenshots and promo tile
- [ ] Privacy tab: single purpose, permission justifications from
      [`permissions.md`](permissions.md), privacy policy URL, and the three data
      certifications
- [ ] Answer the remote-code question **No**, with the `wasm-unsafe-eval`
      explanation ready — expect it to be queried
- [ ] Submit

Expect longer review than the usual few days: broad host access and identity
data both attract manual review. A request for more information is normal and
is not a rejection — answer it from [`permissions.md`](permissions.md) rather
than improvising.

## 5b — Meanwhile, the free routes that already work

Neither replaces a store listing, but both cost nothing and can run today.

- [ ] **GitHub Release.** Attach `dist/formpilot-1.0.0.zip` with both hashes
      (step 2). Anyone can download, unzip and **Load unpacked**. This reaches
      the technical slice of the audience — engineering students, the person in
      a study group who sets things up for everyone else — and it is how the
      first handful of real users will arrive.
- [ ] **Firefox Add-ons** is also free to publish on, and every browser API
      FormPilot uses is supported there. It is not a zero-work option though:
      Firefox's MV3 wants `background.scripts` rather than a service worker and
      requires a `browser_specific_settings.gecko.id`, so it needs a manifest
      variant and a real round of testing. Worth doing, but as its own phase —
      not something to bolt onto a launch week.

## 6 — After it goes live

- [ ] Put the store link(s) at the top of README, replacing "load it unpacked"
      as the primary instruction (keep unpacked as the developer path)
- [ ] Update [`OVERVIEW.md`](../OVERVIEW.md) — it currently says there is no
      listing
- [ ] Install **from the store, on a clean profile**, and run through step 0
      again. The package is not the working tree, and this is the only moment
      you will find out if something did not ship.
- [ ] Verify the installed copy against the tag with `npm run checksums` — the
      first real use of the thing Phase 8 built
- [ ] Only then start Phase 11 distribution

---

## Two failure modes worth naming

**A screenshot with real identity data.** It is the one mistake on this page
that cannot be undone — store images are cached and scraped. Use invented data
for the OCR shot and check every frame twice.

**Rushing a fix through as 1.0.1 before the store review of 1.0.0 completes.**
It restarts the queue. If you spot something non-critical after submitting, hold
it for the next release.
