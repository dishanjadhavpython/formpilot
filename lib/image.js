// FormPilot - resize/compress an image to a portal's exact spec
//
// Government and exam portals do not ask for "a small photo". They ask for
// something like "JPEG, max 600px, between 10 KB and 200 KB" - a BAND, with a
// floor as well as a ceiling. Ordinary compressors target a maximum only, so
// they happily hand back a 6 KB file that the portal then rejects.
//
// THE ALGORITHM
//   1. Decode the file to a canvas with EXIF orientation applied, so photos
//      taken on a phone are not silently rotated.
//   2. Scale the longest edge down to the preset's maxWidthOrHeight.
//   3. Binary-search JPEG quality until the encoded size lands inside the band.
//   4. If even the lowest quality is over the ceiling, shrink the dimensions a
//      step and try again. That is the only remaining lever.
//   5. If the band is genuinely unreachable, say so and explain which end
//      failed, rather than returning a file the portal will reject.
//
// See vendor/README.md for why only the library's helpers are used here and
// never its default export.

import imageCompression from '../vendor/browser-image-compression.mjs';

// JPEG quality bounds. Below ~0.05 the output is unusable; above 0.95 the file
// grows quickly for no visible gain.
const MIN_QUALITY = 0.05;
const MAX_QUALITY = 0.95;
const SEARCH_STEPS = 12;          // 12 halvings resolves quality to ~0.0002

// Dimension ladder, applied on top of the preset's maxWidthOrHeight when
// quality alone cannot get under the ceiling.
const SCALE_LADDER = [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.22, 0.15];

export const DEFAULT_PRESETS = [
  {
    id: 'photo',
    label: 'Passport photo',
    note: 'Typical exam/KYC portrait slot',
    format: 'image/jpeg', maxWidthOrHeight: 600, minKB: 10, maxKB: 200
  },
  {
    id: 'signature',
    label: 'Signature',
    note: 'Small, wide strip',
    format: 'image/jpeg', maxWidthOrHeight: 300, minKB: 4, maxKB: 30
  },
  {
    id: 'document',
    label: 'Document / ID scan',
    note: 'Readable text at a sane size',
    format: 'image/jpeg', maxWidthOrHeight: 1600, minKB: 100, maxKB: 500
  }
];

// --- Canvas plumbing --------------------------------------------------------

/** Decode a file into a canvas with EXIF orientation already applied. */
async function decodeToCanvas(file) {
  // The library's documented helper. It handles the orientation tag, which is
  // the single most common cause of "why is my photo sideways".
  const [image, canvas] = await imageCompression.drawFileInCanvas(file);

  // drawFileInCanvas may hand back an ImageBitmap; release it either way.
  if (image && typeof image.close === 'function') image.close();
  return canvas;
}

function scaleCanvas(source, scale) {
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  if (width === source.width && height === source.height) return source;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  // Better downscaling than the default, which visibly aliases on text.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  // JPEG has no alpha channel; without this, transparent PNGs go black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);

  return canvas;
}

function toBlob(canvas, type, quality) {
  // decodeToCanvas() returns whatever the vendored library's drawFileInCanvas()
  // handed back, and it prefers OffscreenCanvas when the browser supports it
  // (every current Chrome/Edge/Brave). OffscreenCanvas has no toBlob() - only
  // scaleCanvas()'s own document.createElement('canvas') does - so this has to
  // handle both, or every image that does not need resizing fails to encode.
  if (typeof canvas.convertToBlob === 'function' && typeof canvas.toBlob !== 'function') {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed.'))),
      type,
      quality
    );
  });
}

/** Free the backing store; large canvases otherwise linger. */
function release(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}

// --- The band search --------------------------------------------------------

/**
 * @param {File} file
 * @param {{format:string, maxWidthOrHeight:number, minKB:number, maxKB:number}} preset
 * @param {(message:string)=>void} [onProgress]
 * @returns {Promise<object>} result, `ok:false` with a `reason` if unreachable
 */
export async function fitToBand(file, preset, onProgress = () => {}) {
  const { format, maxWidthOrHeight, minKB, maxKB } = preset;
  const minBytes = Math.round(minKB * 1024);
  const maxBytes = Math.round(maxKB * 1024);

  if (minBytes >= maxBytes) {
    return { ok: false, reason: 'INVALID_BAND', message: 'The minimum size must be below the maximum.' };
  }

  const source = await decodeToCanvas(file);

  // Captured now, because release() zeroes a canvas's width and height and the
  // failure paths below report on the original after releasing it.
  const original = {
    bytes: file.size, name: file.name, type: file.type,
    width: source.width, height: source.height
  };

  const longestEdge = Math.max(source.width, source.height);
  const baseScale = Math.min(1, maxWidthOrHeight / longestEdge);

  const inBand = (blob) => blob.size >= minBytes && blob.size <= maxBytes;

  // Track the nearest miss, so a failure can still show the user something.
  let best = null;
  const consider = (blob, canvas, quality) => {
    const distance = blob.size > maxBytes ? blob.size - maxBytes
                   : blob.size < minBytes ? minBytes - blob.size
                   : 0;
    if (!best || distance < best.distance) {
      best = { blob, quality, distance, width: canvas.width, height: canvas.height };
    }
  };

  let attempts = 0;
  let sawUnderMinimum = false;

  for (const step of SCALE_LADDER) {
    const canvas = scaleCanvas(source, baseScale * step);
    onProgress(`Trying ${canvas.width}x${canvas.height}...`);

    try {
      // PNG ignores the quality argument entirely, so dimensions are the only
      // lever available. One encode per rung.
      if (format === 'image/png') {
        const blob = await toBlob(canvas, format);
        attempts++;
        consider(blob, canvas, null);
        if (inBand(blob)) return success(blob, canvas, null, original, source, preset, attempts);
        if (blob.size < minBytes) { sawUnderMinimum = true; break; }
        continue;
      }

      // Bracket the rung before searching it: if the lowest quality is still
      // over the ceiling, no quality on this rung can work - shrink instead.
      const floor = await toBlob(canvas, format, MIN_QUALITY);
      attempts++;
      consider(floor, canvas, MIN_QUALITY);
      if (inBand(floor)) return success(floor, canvas, MIN_QUALITY, original, source, preset, attempts);
      // Do NOT release here: when no downscaling was needed, scaleCanvas hands
      // back the source canvas itself, and releasing it would zero the source
      // that every remaining rung is drawn from. The finally block below
      // releases the working canvas only when it is genuinely a separate one.
      if (floor.size > maxBytes) continue;

      // And if the highest quality is still under the floor, shrinking only
      // makes it smaller. This rung is as good as it gets.
      const ceiling = await toBlob(canvas, format, MAX_QUALITY);
      attempts++;
      consider(ceiling, canvas, MAX_QUALITY);
      if (inBand(ceiling)) return success(ceiling, canvas, MAX_QUALITY, original, source, preset, attempts);
      if (ceiling.size < minBytes) { sawUnderMinimum = true; break; }

      // The band is bracketed on this rung. Binary-search the quality.
      let low = MIN_QUALITY;      // known to encode below the ceiling
      let high = MAX_QUALITY;     // known to encode above the floor
      for (let i = 0; i < SEARCH_STEPS; i++) {
        const quality = (low + high) / 2;
        const blob = await toBlob(canvas, format, quality);
        attempts++;
        consider(blob, canvas, quality);
        onProgress(`Quality ${quality.toFixed(2)} -> ${(blob.size / 1024).toFixed(1)} KB`);

        if (inBand(blob)) return success(blob, canvas, quality, original, source, preset, attempts);
        if (blob.size > maxBytes) high = quality; else low = quality;
        if (high - low < 0.002) break;
      }

      // Bracketed but nothing landed inside: the band is narrower than the
      // smallest quality step the encoder responds to.
      release(canvas);
      release(source);
      return {
        ok: false,
        reason: 'BAND_TOO_NARROW',
        message: `Nothing lands between ${minKB} KB and ${maxKB} KB at these dimensions — the band is narrower than one quality step. Widen it slightly and retry.`,
        best, attempts, original
      };
    } finally {
      if (canvas !== source) release(canvas);
    }
  }

  release(source);

  if (sawUnderMinimum) {
    return {
      ok: false,
      reason: 'TOO_SMALL',
      message: `Even at maximum quality this image encodes below ${minKB} KB — the source has too little detail. Use a larger or sharper original, or lower the minimum.`,
      best, attempts, original
    };
  }
  return {
    ok: false,
    reason: 'TOO_BIG',
    message: `Could not get under ${maxKB} KB even at the lowest quality and smallest size. Raise the maximum, or reduce the dimension limit.`,
    best, attempts, original
  };
}

function success(blob, canvas, quality, original, source, preset, attempts) {
  const result = {
    ok: true,
    blob,
    quality,
    width: canvas.width,
    height: canvas.height,
    bytes: blob.size,
    format: preset.format,
    attempts,
    original,
    savedPercent: Math.max(0, Math.round((1 - blob.size / original.bytes) * 100)),
    filename: outputName(original.name, preset)
  };
  release(source);
  return result;
}

function outputName(original, preset) {
  const base = original.replace(/\.[^.]+$/, '') || 'image';
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[preset.format] ?? 'jpg';
  return `${base}-${preset.id ?? 'custom'}.${extension}`;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
