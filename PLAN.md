# FormPilot — build plan

From `FormPilot_Build_Guide.pdf`. One phase per session; stop at boundaries,
never mid-phase. After each phase: load unpacked, run the "done when" check,
commit as `phase N: short name`.

Rules that apply to every phase are in [CLAUDE.md](CLAUDE.md).

| # | Phase | Status |
|---|-------|--------|
| 0 | Setup & scaffold | ✅ done — `ce1b2ab` |
| 1 | Encrypted vault | ✅ done — `e745ef4` |
| 2 | Autofill engine | ✅ done |
| 3 | Resize/compress to portal spec | ✅ done |
| 4 | OCR auto-extract (stretch) | ✅ done |
| 5 | Polish & reliability | ✅ done |
| 6 | Document (file-upload) autofill | ✅ done |
| 7 | Shippable: licence, privacy policy, permission diet, CI | ✅ done |
| 8 | Earn trust in the first ninety seconds | ✅ done |
| 9 | Launch — Edge Add-ons (free) first, Chrome when the $5 is available | 🟡 prepared — submission pending |
| 10 | Choice fields — radio groups, and the checkbox refusal | ✅ done |
| 11 | Crop to a shape, and change passphrase | ✅ done |
| 12 | OCR pre-processing — deskew, contrast, upscale | ✅ done |
| 13 | Reach — split `options.js`, then `_locales` (en, hi, mr) | planned |
| 14 | Distribution | ongoing |

Phases 0–6 built the extension. Phases 7–9 are about the gap between "an
extension that works" and "an extension people can find, trust and install" —
almost none of it feature work. Phases 10–12 close the gaps that make a real
portal application fail halfway through; the old single Phase 10 was four
phases wearing a trenchcoat and has been split.

---

## Phase 0 — Setup & scaffold ✅

MV3 skeleton: `manifest.json` (storage, activeTab, scripting; `<all_urls>`),
service worker, popup with a title and one button, options page, icons.

**Done when:** the extension loads with no errors and the popup opens.

## Phase 1 — Encrypted vault ✅

Passphrase setup + unlock via Web Crypto. PBKDF2 (random salt, 310k iterations)
→ AES-256-GCM (random IV per save), stored in `chrome.storage.local`. Fields:
fullName, dob, email, phone, address, pan, aadhaarMasked, plus custom fields and
document images by type. Lock/unlock buttons.

**Done when:** add data, lock, reload, unlock, see it again — and the raw stored
value is unreadable ciphertext.

**Deferred out of this phase:** change-passphrase flow; idle auto-lock (Phase 5).
Direct document attachment is capped at 2 MB; larger files go through the Phase 3
image tool, which compresses then saves to the vault.

## Phase 2 — Autofill engine ✅

The core feature. `content.js` scans the page and infers each field's meaning;
the popup's "Fill this form" button sends vault data to it.

**Resolved design decision.** The popup cannot decrypt anything — the key is
non-extractable and lives in the options page. On unlock, the options page
publishes the *decrypted text fields* (not the key, not the documents) to
`chrome.storage.session`, which is memory-only, never hits disk, and is pinned
to `TRUSTED_CONTEXTS`. The popup reads that and hands values to the content
script. Cleared on Lock and on browser restart.

- Match order: taught per-site mapping → `autocomplete` attribute → name / id /
  label / placeholder / aria-label against the synonyms in `lib/match.js`.
  Ties break toward the longest matched synonym, so "first name" beats "name".
- `content.js` is injected on demand via `chrome.scripting.executeScript`, not
  declared in the manifest — it never runs on a page you did not ask it to.
- Fills via the native prototype value setter (React/Vue ignore plain `.value`
  assignment), then dispatches `input` + `change`.
- Outlines filled fields, shows "filled X of Y" in a Shadow-DOM toast.
- Safety: never submits, never fills passwords, skips hidden honeypots, and
  never overwrites a field that already has a value.
- Teach mode: click a field on the page, label it, and the mapping is saved to
  `local.siteMappings` under that hostname for next time.

**Done when:** on a real signup form, "Fill this form" fills your stored fields,
highlights them, and does not submit.

**Deferred:** checkbox/radio/file inputs; same-origin iframes.
(The mappings review/delete UI landed alongside Phase 3.)

## Phase 3 — Resize/compress to portal spec ✅

`lib/image.js` + the Image tool section of the options page. Pick an image and a
preset `{format, maxWidthOrHeight, minKB, maxKB}`; the longest edge is scaled to
the limit, then JPEG quality is binary-searched with `canvas.toBlob` until the
output lands inside the band. 3 presets plus a custom-spec form whose specs can
be saved. Shows original vs result, percent saved, dimensions, quality and
encode count, with Save-to-vault and Download.

**The band is the point.** Ordinary compressors target a *maximum*; portals
specify a floor as well, and a 6 KB file gets rejected just as surely as a 6 MB
one. Failure is diagnosed rather than hidden: `TOO_BIG`, `TOO_SMALL`,
`BAND_TOO_NARROW` and `INVALID_BAND` each explain which end failed, and the
nearest miss is still offered with an explicit out-of-band warning.

**Vendoring caveat — read `vendor/README.md`.** `browser-image-compression`'s
default export violates MV3 unless `useWebWorker: false` is passed: it builds a
worker from a `blob:` URL and `importScripts` the library from jsDelivr at
runtime. `lib/image.js` uses only the documented namespace helpers
(`drawFileInCanvas`, for EXIF-correct decoding) and never the default export, so
neither path is reachable.

**Done when:** a big photo + a "10–200 KB JPEG" preset yields a file inside that
band at the right dimensions.

**Deferred:** cropping / aspect-ratio enforcement (portals that demand exactly
3.5x4.5 cm need a crop step, not just a scale); PNG can only be tuned by
dimension because the encoder ignores the quality argument.

## Phase 4 — OCR auto-extract (stretch) ✅

`lib/ocr.js` + the "Read an ID image" section. tesseract.js 7.0.0 with core
7.0.0 and the English LSTM model, all vendored (~6.8 MB) — see
`vendor/README.md`, which documents the three CDN fetches that had to be
overridden, the `workerBlobURL: false` requirement, why only one of six core
variants is shipped, and the version-pairing trap where npm's `latest` core tag
is *older* than the one tesseract.js 7 requires.

Required a manifest change: MV3 blocks all WebAssembly without
`'wasm-unsafe-eval'` in the extension CSP.

Heuristics: PAN (with digit/letter OCR-confusion repair), date of birth in three
formats with range validation, Aadhaar (masked to the last 4 digits inside the
extractor), and a name line picked as the most confident all-caps line that is
not a known label. Every suggestion is editable and individually tickable;
Apply writes into the visible form, and only "Save vault" encrypts it.

**Done when:** a clear PAN/marksheet image pre-fills a couple of fields.

**Deferred:** no image pre-processing (deskew, threshold, upscale), which is the
biggest available accuracy win on phone photos; English only; the name-line
heuristic is weak on layouts where the name is not in capitals.

## Phase 5 — Polish & reliability ✅

**Idle auto-lock.** Driven by `chrome.alarms` in the service worker, not by a
page — the vault has to lock itself when every extension page is closed, and a
worker variable would not survive the worker sleeping. Re-armed on activity, so
"5 minutes" means five minutes of *inactivity*. When it fires it removes the
session copy; an open options page sees that via `chrome.storage.onChanged` and
drops its in-memory key to match. Added the `alarms` permission.

**Encrypted export/import** (`lib/backup.js`). No new cryptography: the stored
record is already a self-describing encrypted envelope, so a backup is that
envelope in a file. Import validates the shape before writing — a malformed
record would leave the vault permanently unopenable — then forces a re-unlock
with the passphrase that backup was made under. The Backup section is visible in
*every* state, because restoring is what you need right after a reinstall, when
no vault exists and the page is in setup.

**Error states.** `window.onerror` / `unhandledrejection` surface into a banner;
a thrown error in a handler otherwise fails silently and the page just looks
broken.

**Self-review found a real leak.** `lock()` cleared the key and the vault fields
but left OCR-recognised text in the DOM, the image tool's `lastResult` Blob and
its live object URL, the preview `<img>` still showing a document, and the file
inputs still naming what you picked. All of that came off your documents. Split
into `lockLocally()` (tear down this page, safe to call when the session copy is
already gone) and `lock()` (that plus revoking the popup's copy).

**Done when:** lock-on-idle works, and you can export, reinstall, import, recover.

**Deferred:** no change-passphrase flow, so a backup is forever tied to the
passphrase in force when it was taken.

## Phase 6 — Document (file-upload) autofill ✅

Portals that ask you to upload an Aadhaar/PAN/photo/signature image were
untouched by Phase 2 - `input[type=file]` was explicitly in `SKIP_TYPES`, and
vault documents were explicitly excluded from the `chrome.storage.session`
copy the popup/content script fill from. Both gaps close together: document
labels ("Upload Aadhar Card Image", "Upload Signature") are matched against a
small synonym table in `lib/match.js` (`DOC_SYNONYMS`, keyed by the same
`photo`/`signature`/`pan`/`aadhaar`/`idProof` type ids `options.js` already
uses), and the matching stored image is attached via
`el.files = dataTransfer.files` on the same trusted click that fills text.

- `publishSession()` now includes one document per type (most recently
  added) alongside the text fields. `chrome.storage.session` has its own
  ~10MB quota; a publish that goes over it retries once with documents left
  out rather than losing text autofill too.
- Detection reports document *types and mimes* (`docKeys`/`docMimes`),
  matching how it already reports text *key names* - never the image itself.
  Real bytes only cross in a FILL, in a `docs` map scoped to the types the
  page's plan asked for, after the same trusted click as everything else.
- File inputs use a looser visibility check than text fields
  (`isFillableDoc`, `content.js`): hiding a file input under a styled "Add
  File" button with `opacity:0` is normal UI, not a honeypot, so only actual
  unreachability (`display:none` ancestor, off-screen position) disqualifies
  one. Reusing the text-field honeypot check verbatim would have broken the
  feature on the exact pattern it exists to handle.
- `el.accept` is checked against the stored document's mime
  (`M.acceptsMime`) so a field pinned to `.pdf` is correctly left alone - the
  vault only ever stores images.

**Done when:** a vault with Aadhaar/PAN/signature images saved, opened
against a form with three `input[type=file]` fields labelled "Upload Aadhar
Card Image" / "Upload PAN Card Image" / "Upload Signature" (one a plain file
input, one styled as a custom button with the native input visually hidden),
attaches the right image to the right field on one Fill click, leaves a field
alone if it already has a file picked, and never touches submit.

**Deferred:** PDF/other document formats (vault only stores images);
`multiple` file inputs; document types outside the Identity group
(marksheets etc.); teach-mode labelling for document slots.

## Phase 7 — Shippable ✅

Nothing here is a feature. It is everything the project needed in order to be
installable by somebody who is not its author.

**A licence.** There wasn't one. README licensed only the vendored
dependencies, which under copyright default means *all rights reserved* on
FormPilot itself — nobody could legally fork it, contribute to it, or in many
workplaces install it. Self-defeating for a project whose pitch is "audit me
yourself". Now MIT.

**A privacy policy** (`PRIVACY.md`). The Chrome Web Store requires a hosted
policy URL from any extension handling personal or sensitive data, and this one
handles Aadhaar and PAN. It is also the easiest such document anyone will ever
write: nothing is collected because there is nowhere to send it.

**`<all_urls>` became optional, and this is the real change.** Declared as a
required host permission, the install prompt reads *"Read and change all your
data on all websites"* for every single installer — including everyone who
never turns detection on. It was never needed for the main feature: clicking
Fill runs on `activeTab`, which grants access to the one tab whose icon was
clicked. Only proactive detection needs standing access to every site, and that
is a setting.

So `<all_urls>` moved to `optional_host_permissions`, and the `suggestFills`
toggle in `options.js` is where the browser's own prompt now happens. Three
things that were easy to get wrong:

- `chrome.permissions.request()` needs a **live user gesture**, so it hangs off
  the checkbox's `change` event, not the Save button — by the time a save
  handler has awaited anything, the gesture is spent.
- The permission, not the stored preference, is the truth. A user can revoke it
  from `chrome://extensions` and nothing tells the extension. So `loadSettings()`
  reconciles the checkbox against `permissions.contains()`, saving refuses to
  write `suggestFills: true` without the grant, and both `detectForms()` and
  `releaseFill()` ask again live rather than trusting detection-time state.
- Turning the toggle off calls `permissions.remove()`. A permission held but
  unused is still one the user is trusting us with, and asking again later costs
  one prompt.

**The duplicated `expandValues` is now guarded.** `background.js` keeps its own
copy of `lib/match.js`'s version (the worker is a module; `match.js` is a
classic script for the content script's world) under a comment saying "keep in
step" — with nothing enforcing it. The tests only ever exercised the `match.js`
copy. Drift there would make the badge count from detection disagree with what a
fill actually writes: an intermittent bug in the code path that is hardest to
observe. The audit now lifts the worker's copy out of the source, runs both
against ten fixtures covering every branch they share, and asserts identical
output.

**Also:** CI on every push and pull request (with a guard asserting the project
still has zero npm dependencies); the four service-worker `console.log` calls
gated behind `DEBUG`, with the `console.warn` about session access level left
ungated because that one signals a real security degradation; README's stale
limitations list corrected (it still claimed file inputs were unhandled, which
Phase 6 shipped, and omitted that `<select>` works); and the version bumped to
`1.0.0`, since `0.1.0` reads as alpha for software that passes 409 assertions.

Two new mutations prove the two new audit checks actually fail when broken —
making `<all_urls>` required again, and drifting the worker's `expandValues`.

**Done when:** a stranger can clone the repo, read the licence, see a green CI
badge, and install without Chrome warning them about all their data on all
websites. ✅

**Deferred to Phase 8:** the welcome page on install, try-it-before-passphrase
mode, the keyboard shortcut, release checksums, and a private security contact.

## Phase 8 — Earn trust in the first ninety seconds ✅

The old first run had its order of operations backwards. Installing produced a
toolbar icon and no explanation; clicking it produced a *Locked* badge; and the
only way forward was to invent a passphrase nobody can ever recover and then
type in a real name, a real phone number and a real Aadhaar — all before seeing
a single thing work. That is a large ask for software you have known for ninety
seconds, and it is where people quit.

**A welcome page** (`welcome.html`), opened once from `onInstalled` on
`reason === 'install'` — not on update, not on every worker wake. It says what
the extension does, states the irreversible-passphrase warning once and plainly
rather than burying it in a form, and offers two doors: create a vault, or try
it first.

**A try-it demo** (`demo.html`) — a pretend portal application form, twenty
fields, filled with details belonging to a person who does not exist. No
passphrase, no vault, no storage, nothing saved.

The design decision that matters: **it runs the real matcher.** Every decision
comes from `lib/match.js` unchanged — the same synonym table, the same `NEVER`
and `THIRD_PARTY` guards, the same specific-beats-generic tie-break that
content.js uses on real pages. A mock-up producing plausible-looking output
would be a lie told at exactly the moment somebody is deciding whether to trust
us with their identity documents, so the audit now fails if the real calls
disappear, and a mutation proves that check bites.

What the demo deliberately does *not* reuse is content.js's field scanner —
that would be a second copy to keep in step, which is the problem Phase 7 just
finished guarding against. It walks its own fixed twenty fields. Only the
matching, the part that is actually clever, is shared.

The form is built so the **refusals** are the point: nine of the twenty are left
alone, each with a reason stated in a sentence — a password, a pre-filled field,
"Father's Name", "Emergency Contact Number", a company name, a username, an OTP
and a captcha. Anything can type a name into a box. Refusing to put your name in
your father's field is the part worth showing.

**A keyboard shortcut**, `Ctrl+Shift+F` / `⌘⇧F`. Filling happens dozens of times
per application session and "click the icon, then click Fill" is enough friction
to send people back to typing. It needs no host permission: invoking a
registered command grants `activeTab`, exactly like clicking the toolbar icon.
It keeps the two-pass PLAN/FILL split whole — collapsing it into one message
would mean handing the page the entire vault to pick from — and the narrowing
step was factored out of `releaseFill()` into `narrow()` so the chip path and
the shortcut path cannot drift into releasing different amounts.

**Release verification** (`tools/checksums.mjs`, `npm run checksums`). "No build
step" has always been filed under simplicity; it is really an unusual security
property. Because nothing is compiled, minified or generated, the code a
stranger reads here is byte-for-byte the code running in their browser — a claim
a password manager with a build pipeline cannot make. A property nobody can
check is worth nothing, so this fingerprints every shipped file plus one
aggregate hash, and README explains how to diff an installed copy against the
tag.

**A private disclosure route** in SECURITY.md. It previously asked finders to
open an issue, which for a vault means a working attack is public from the
moment it is reported until a fix clears store review.

Six new mutations, all caught: the demo turned into a scripted fake, the demo
reading the real vault, the shortcut dropping its PLAN pass, the shortcut
ignoring the plan and sending everything, plus Phase 7's two.

**Done when:** somebody who has never seen FormPilot watches a form fill itself
before typing a single real detail — and can prove the code they installed
matches the code they read. ✅

**Deferred:** nothing from this phase. The store listing itself is Phase 9.

## Phase 9 — Launch 🟡

Everything that can live in the repository does. The rest needs an account, a
card and a browser, and is checklisted rather than done — see
[store/CHECKLIST.md](store/CHECKLIST.md).

**A packaging tool** (`tools/package.mjs`, `npm run package`) with a
hand-rolled ZIP writer. Two constraints met at once: no npm dependencies, so no
archiver library; and a release that can be *verified*, which means the archive
has to be reproducible. Shelling out to `zip` gives neither — it stamps the
local mtime into every entry, so two builds of identical code differ and the
published hash proves nothing. Pinning every timestamp to the ZIP epoch makes
the output a pure function of file contents and names. Verified: two builds are
byte-identical, and the extracted archive is byte-for-byte the source tree, 31
files, nothing missing and nothing extra.

`tools/shipped.mjs` now owns the single answer to "which files does the browser
get", because the checksums tool and the packager both need it and two copies
would drift in opposite directions — a fingerprint list covering a file the
package omits, or a package carrying a file nobody fingerprinted.

Two deliberate inclusions in the package, both licence obligations rather than
preferences: `LICENSE` (MIT requires the notice in "all copies", and a shipped
extension is a copy) and the `vendor/` licences alongside the code they cover.

**A package test suite** (`test/package.test.mjs`, 20 assertions). Store review
is slow and a rejection costs days, but the worse failure is the one that
*passes* review: a package missing a stylesheet installs fine, loads, and is
broken for every user until the next release clears the queue. So it checks
that every manifest-referenced file ships, every script/style/image any HTML
page pulls in ships, every programmatically injected path ships (`content.js`
and `lib/match.js` are named nowhere in the manifest), and every OCR asset
ships — that last one because a missing one does not crash, it silently
restores a CDN fetch. Plus the other direction: no `test/`, `tools/`, `store/`
or docs in the archive.

**Listing material**, all in `store/`: the copy for both stores, per-permission
review justifications, a five-shot screenshot list, a 440×280 promo tile, and
the checklist.

The positioning call from the strategy is baked into the copy. FormPilot is not
"another autofill extension" — framed that way it competes with Chrome's
built-in autofill and every password manager, and loses, because they sync and
it deliberately does not. Framed as the tool for Indian exam and government
portal applications it has no real competitor. The screenshot order follows
from the same logic: the KB-band resize goes first, not the vault, because a
vault screenshot looks like every password manager's vault screenshot and gets
pattern-matched away in a second.

**Edge Add-ons goes first, and the reason is not only the fee.** Microsoft
charges nothing to publish; Chrome's US$5 is a Chrome cost, not an extension
cost, so no part of a launch has to wait on it. Edge is also the default browser
on every Windows machine, including a great many of the budget laptops and
shared machines this audience actually uses, and its store is far less saturated
— a new extension is more discoverable there than as one of thousands on Chrome.
Arriving at Chrome's stricter review later, with a live listing and real install
numbers behind you, is a better position than arriving with nothing.

There is no way around the Chrome fee, and it is worth stating plainly rather
than hunting for one: no waiver, no student programme, no free tier, and Chrome
blocks self-hosted `.crx` installs on Windows and macOS, so self-hosting reaches
nobody who is not already in developer mode. A GitHub Release plus "Load
unpacked" does reach the technical slice of the audience, and that is where the
first real users will come from.

Firefox Add-ons is free to publish on too, and every browser API FormPilot uses
is supported there — but its MV3 wants `background.scripts` rather than a
service worker and a `browser_specific_settings.gecko.id`, so it needs a
manifest variant and a real round of testing. Its own phase, not a launch-week
addition.

**Done when:** a link exists that installs FormPilot in two clicks.

**Not done here, and it needs you:** the free Partner Center registration, the
GitHub Pages deploy for the privacy-policy URL, the five screenshots, the upload
— and, before any of it, ten minutes actually driving the extension in a
browser. Every browser-dependent change in Phases 7 and 8 is verified against
stubs, not against Chrome. Step 0 of the checklist is that walkthrough.

## Phase 10 — Choice fields ✅

The old Phase 10 ("win the market") was four phases wearing a trenchcoat. Split
into 10, 11 and 12; this is the first, and it is the one that changes how a real
portal form reports.

**The problem.** Indian portal forms are dense with radio groups — Gender,
Category, Domicile, Marital status — and every one of them counted towards "Y"
and was never filled. A nineteen-field form reported *"filled 6 of 19"* and read
as broken even when the six were right.

**Three new vault fields**: `gender`, `category`, `maritalStatus`. Dropdowns in
the options page rather than free text, so the stored value is drawn from the
same vocabulary the matching expects. Encrypted like everything else.

**Radio groups are filled; the group is the unit.** `radioGroups()` buckets by
`name` within a form — the same name in two forms is two different questions —
and skips any group already answered. `describeGroup()` reads the *question*
(the `name`, the `<legend>`, explicit ARIA labelling) and deliberately not the
fieldset's `textContent`, which would sweep up every option label
("gender male female other") and match on the answers instead.

Visibility is judged like a file input's rather than a text field's: a custom
radio UI routinely hides the real `<input>` under a styled `<label>`, so only
actual unreachability disqualifies one.

**The two-pass split survives.** Which radio to tick depends on the value, and a
plan runs before any value has crossed into the page — so the plan names the
group and the key it needs, and resolving that to one option happens at fill
time, locally. Radios ride the same `keys`/`values` channel as text, because
they answer the same vault keys: nothing more crosses into a page than a fill
already carried.

**Checkboxes are refused permanently, and that became hard rule 1a.** A checkbox
on these forms is overwhelmingly a statement the user is making — "I hereby
declare the above to be true", "I accept the terms". Ticking one asserts it on
their behalf, which is the same category of act as pressing Submit for them. The
few checkboxes carrying mere facts are not worth the ones that do not.

**A real bug fixed on the way.** `fillSelect()`'s loose pass was a substring
test, and `'female'.includes('male')` is `true` — a user who stored "Male" would
have had "Female" selected. Option matching moved into `chooseOption()` in
`lib/match.js`, shared by `<select>`s and radios so the two can never disagree,
and its loose pass is now word-boundary matched. Values of two characters skip
that pass entirely, or "SC" would hit "SC/ST" and everything near it.

**`CHOICE_ONLY`.** `gender`, `category` and `maritalStatus` fill only a control
with a fixed set of options. `category` is a generic enough word to match a box
labelled "Job Category", and "OBC" typed into that is wrong rather than merely
useless. The restriction is what makes a bad guess inert: the value either
matches an offered option or nothing happens.

**Fixtures.** `test/form.html` gained three radio groups, an already-answered
group that must not change, and three checkboxes (a declaration, terms, a
newsletter) that must stay unticked — graded as `CONSENT VIOLATION` if they are
not. `demo.html` shows the same, so the try-it page keeps telling the truth
about what the real thing does.

Verified against both fixtures with the real matcher: every group resolves to
the right key and ticks the right option, the answered group is skipped, and
every checkbox is left alone.

Four new mutations, all caught: filling checkboxes, reverting option matching to
a substring test, letting a choice-only key fill free text, and faking only the
demo's radio path — that last one because the demo now has two independent
decision paths and a whole-file grep for `M.inferKey` kept reporting green while
one of them was fake.

**Done when:** a form with Gender, Category and Marital status radio groups has
all three answered on one Fill click, and no declaration checkbox is ever
ticked. ✅

**Deferred:** same-origin iframes; teach mode for radio groups.

## Phase 11 — Crop to a shape, and change passphrase ✅

Two places the workflow broke. Both had been deferred since the phase that
introduced them.

### Cropping

A portal asking for "3.5 × 4.5 cm" is asking for an **aspect ratio**, and the
one thing scaling cannot do is change an aspect ratio. So the image tool sent
the user to another application at precisely the moment it was about to be
useful — and then they came back and ran the band search on whatever that
application produced.

`planCrop()` in `lib/image.js` is deliberately pure: source dimensions, a ratio,
a normalised focus point and a zoom, in; a rect in source pixels, out. No canvas,
no DOM, no image. That puts the part most likely to be subtly wrong — a rect
hanging one pixel over the boundary, a ratio drifting as it rounds, a focus point
escaping — under Node, where 30-odd cases can hammer it. Six shapes ship
(3.5×4.5 cm, square, two signature strips, A4, none).

**Crop first, resize second.** The other order scales pixels that are about to
be discarded, and makes `maxWidthOrHeight` apply to an edge the output does not
have.

The UI shows the *whole* image with everything outside the target shape shaded
rather than hidden, so you can see what you are giving up. Dragging moves the
focus; a slider zooms. `original` is captured before the crop, so the report
honestly says 4000×3000 became 350×450 instead of pretending the crop never
happened.

One bug found by its own test: a non-finite focus fell through `NaN || 0` to the
left edge instead of the centre — a plausible-looking wrong answer nobody would
have reported as a bug.

**Locking had to learn about it.** The crop stage holds an object URL of the
*full, uncropped* original — the most revealing single thing on the page, and
not something `clearResult()` knew about, since that only tracks the compressed
output. `lockLocally()` now releases it and hides the stage.

### Change passphrase

Before this, a passphrase you suspected was compromised was one you were stuck
with: export, wipe, start again was the only remedy, and every backup stayed
tied to whatever passphrase was in force when it was taken.

Three decisions:

- **The current passphrase is the authorisation.** Being unlocked is not enough
  — anyone at an unattended machine is also "unlocked".
- **A fresh salt.** Everywhere else the salt is fixed for the life of the vault,
  and regenerating it on an ordinary save would be a bug. A passphrase change is
  the one moment everything is re-encrypted anyway, and separate salts stop one
  PBKDF2 run per candidate testing an old backup and the new record at once.
  CLAUDE.md's invariant was reworded accordingly: fixed for the life of a
  *passphrase*, not of the vault.
- **Verify before the caller writes.** `changePassphrase()` decrypts the record
  it just produced, with the new key, before returning it. A half-applied change
  is a vault nothing can open, which is strictly worse than no change. It also
  writes nothing itself — the caller persists, and only a record already proven
  to open.

The UI refuses to run over unsaved edits, because the re-encryption works from
the record on disk and an edit still in the form would be silently discarded.
`lockLocally()` also clears the three passphrase boxes: an idle lock must not
leave a passphrase sitting in the DOM of an unattended screen.

### On the harness

The mutation for salt reuse came back MISSED, and the reason was better than the
mutation: `createVault()` opens with the *same two lines* and comes first in the
file, so an unanchored `String.replace` had been mutating the wrong function —
and nothing guarded `createVault`'s salt at all. Anchored the mutation, and added
the missing check plus a mutation for it.

**Done when:** a 4 MB landscape photo becomes a 350×450 portrait JPEG inside a
20–50 KB band without leaving FormPilot, and a passphrase can be changed and the
vault still opens. ✅

**Deferred:** rotation and straightening; OCR pre-processing moves to Phase 12.

## Phase 12 — OCR pre-processing ✅

Every real input to OCR is a phone photo of a card lying on a desk: held at an
angle, lit unevenly, often smaller than the engine wants. PLAN.md has called
this the biggest available accuracy win since Phase 4.

**The obvious move is the wrong one, and it is worth being precise about why.**
Threshold everything to hard black and white — that is what "pre-processing for
OCR" usually means, and it dates from the Tesseract 3 era. Tesseract 4/5 is an
LSTM engine: it thresholds internally, and it was trained on rendered text with
antialiasing intact. A hard binary image throws away the greyscale edge
information the network actually uses, and on a photo with uneven lighting a
*global* threshold additionally eats whole regions — exactly the case
pre-processing was supposed to help with.

So the engine is fed **greyscale**, contrast-normalised, deskewed and upscaled.
Binarisation happens too, but only *internally*, as the input to skew
estimation, where a clean two-level image is genuinely what the algorithm needs.
That distinction is the design.

**`lib/preprocess.js` keeps its algorithms pure** — typed arrays in, numbers
out, no canvas and no DOM. That is not tidiness: it means a page sheared by
exactly 5° can be generated in Node and the estimator asked whether it says 5°.
A wrong answer from pre-processing does not look like a bug, it looks like OCR
being bad, so it needed to be checkable without a browser or a human squinting
at a preview.

- **Otsu's threshold**, one pass over a 256-bin histogram, parameter-free.
- **Percentile contrast stretch** rather than min/max, so one blown highlight or
  a dust speck cannot define the range and neutralise the stretch. A flat image
  is left alone — scaling a one-level range by 255 turns sensor noise into a
  barcode.
- **Skew by projection profile**: shear the ink through candidate angles and
  keep the one whose row totals are spikiest. Sum of squares rather than
  variance, because the total ink is identical at every angle — the same pixels
  are only re-binned — so the mean is constant and the orderings agree. Coarse
  1° sweep, then 0.1° around the winner, which costs about a tenth of a single
  fine sweep. **Measured: worst error 0.1° across −10° to +10°**, which is the
  search resolution.
- It refuses to answer when it cannot know: too little ink, or a mostly-dark
  image (a dark background, not text). A confident wrong angle is worse than
  none — it resamples the image and makes the reading worse with nothing to
  blame.

**Details that only bite in a browser.** Rotation fills its new corners with
paper white, because a transparent margin composites to black and the engine
reads a black frame as ink. Upscaling uses whole-number factors only, which
resample far more cleanly than 1.37×. The decode is `lib/image.js`'s, shared
deliberately: the EXIF orientation tag is the most common reason a phone photo
arrives sideways, and OCR on a sideways card reads nothing at all.

**A clean-up failure falls back to the original file.** Degrading to slightly
worse OCR is fine; degrading to no OCR because of an exotic format is not.

The UI reports what was actually done — "enlarged 2x, straightened 3.3°,
contrast evened out" — so a surprising reading has an explanation and the toggle
has a visible consequence. Nothing happened, nothing is claimed.

Six new mutations, all caught, including one that came back MISSED first: the
audit was grepping for the `MAX_SKEW_DEGREES` identifier, which is referenced
several times, so renaming the constant and widening the bound to 90° kept
reporting green. It now checks the value.

**Done when:** a tilted, dimly lit phone photo of a PAN card reads better with
the toggle on than off, and the panel says what it did. ✅

**Deferred:** adaptive/local thresholding (Sauvola) for severe lighting
gradients; perspective correction for a card photographed at an angle rather
than merely rotated; languages other than English.

---

## Definition of done (v1)

- Loads as an unpacked MV3 extension with no console errors.
- Vault stores fields + document images, encrypted; unlocks by passphrase;
  auto-locks on idle.
- "Fill this form" fills a real web form with review and no auto-submit.
- Image tool outputs a file inside a chosen KB band at the right dimensions.
- (Stretch) OCR pre-fills a couple of fields with confidence shown.
- Encrypted export/import works; README present; everything runs offline.
