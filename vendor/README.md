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
