# vendor/

Third-party code, committed here on purpose. Manifest V3 forbids loading code
from a remote origin at runtime, so every dependency ships inside the extension.

Nothing in this folder may be replaced with a CDN `<script>` tag or a dynamic
`import()` of a URL. If a library needs updating, download the release, verify
its hash, and update the table below.

## browser-image-compression

| | |
|---|---|
| Version | 2.0.2 |
| License | MIT (see `LICENSE-browser-image-compression.txt`) |
| Source | `https://registry.npmjs.org/browser-image-compression/-/browser-image-compression-2.0.2.tgz` |
| Tarball integrity | `sha512-pBLlQyUf6yB8SmmngrcOw3EoS4RpQ1BcylI3T9Yqn7+4nrQTXJD4sJDe5ODnJdrvNMaio5OicFo75rDyJD2Ucw==` (matches the npm registry) |
| File | `browser-image-compression.mjs` (the ESM build, `dist/`) |
| File SHA-256 | `fdb2db089dcd553972e417c3f0735a2e3ae2abaad64cd196bb28477755e692d9` |

Source maps and the UMD build were not vendored — they are not needed at runtime.

### ⚠️ Never call the default export

`imageCompression(file, options)` — the library's main entry — **violates
Manifest V3** unless `useWebWorker: false` is passed, and `useWebWorker`
defaults to **true**. On the default path it:

1. builds a Web Worker from a `blob:` URL, which MV3's `script-src 'self'`
   blocks, and
2. inside that worker calls
   `importScripts('https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/...')`
   — fetching **remote code at runtime**, which is exactly what MV3 bans and a
   guaranteed Web Store rejection.

`lib/image.js` therefore uses only the documented helpers on the namespace and
never the default export, so neither code path is reachable:

- `imageCompression.drawFileInCanvas(file)` — decodes the file into a canvas
  with EXIF orientation already applied (phone photos are otherwise sideways).

Resizing and the file-size band search are done with native `canvas.toBlob`,
because the library targets a *maximum* size (`maxSizeMB`) and portal specs
require landing inside a **minimum–maximum band**.

## tesseract.js (OCR)

| | |
|---|---|
| `tesseract.js` | 7.0.0, Apache-2.0 |
| `tesseract.js-core` | **7.0.0**, Apache-2.0 |
| `@tesseract.js-data/eng` | 1.0.0 (the `4.0.0_best_int` LSTM model) |

Vendored files, all under `vendor/tesseract/`:

| File | Size | SHA-256 |
|---|---|---|
| `tesseract.esm.min.js` | 63 KB | `64871d76c75609fd5413b88a8171e2ef40deedd77d5875ba23df104b2d05eb29` |
| `worker.min.js` | 111 KB | `576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d` |
| `tesseract-core-simd-lstm.wasm.js` | 3.9 MB | `c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38` |
| `eng.traineddata.gz` | 2.8 MB | `45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91` |

Tarball integrity verified against the npm registry for all three packages.

### Version pairing is not obvious

`tesseract.js@7.0.0` requires `tesseract.js-core@^7.0.0`, but npm's `latest` tag
for the core is **6.1.2** — 6.1.2 was published *after* 7.0.0, so `npm i` or a
CDN "latest" link gives you a mismatched pair. Core 7.0.0 was fetched by exact
version. If you upgrade, check this pairing again.

### Three separate remote fetches, all overridden

Left at defaults, tesseract.js reaches the network in three places. `lib/ocr.js`
overrides every one:

1. **`workerPath`** → jsDelivr. Worse, **`workerBlobURL` defaults to `true`**,
   which does `new Worker(URL.createObjectURL(new Blob([...])))` — and MV3's
   `script-src 'self'` blocks `blob:` workers. Both the path and
   `workerBlobURL: false` are required; the latter selects the plain
   `new Worker(path)` branch.
2. **`corePath`** → jsDelivr, loaded inside the worker via `importScripts`.
3. **`langPath`** → jsDelivr, for `eng.traineddata.gz`.

### Only one core variant is vendored

The core ships six builds (plain / SIMD / relaxed-SIMD × full / LSTM-only),
about 29 MB in total. The worker's resolution rule is:

> if `corePath` ends in `.js`, use that exact file; **otherwise** feature-detect
> SIMD support and append a filename.

Pointing `corePath` straight at `tesseract-core-simd-lstm.wasm.js` takes the
first branch, so feature detection never runs and no other variant is ever
requested. That is deterministic and saves ~25 MB.

The `.wasm.js` build is self-contained: the WebAssembly module is embedded as a
3.8 MB base64 string (it begins `AGFzbQ`, the `\0asm` magic), so the separate
`.wasm` file is not needed.

`4.0.0_best_int` is the LSTM-only integerised model — the correct partner for
the `-lstm` core, and 2.8 MB against 10.4 MB for the legacy-combined data.

### This required a manifest change

`manifest.json` now declares:

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

MV3 refuses to instantiate **any** WebAssembly without `'wasm-unsafe-eval'`.
Despite the name it does not enable `eval()` or remote code — `'self'` still
confines every script to files shipped inside this extension.

### Verifying it stays offline

Open DevTools on the options page, filter the Network tab by `tesseract`, and
run the OCR tool. Every request must be a `chrome-extension://` URL. A
`cdn.jsdelivr.net` entry means one of the three overrides has been lost.
