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

// --- Cropping ---------------------------------------------------------------
//
// Scaling alone cannot satisfy "3.5 x 4.5 cm". A portal that specifies a
// physical size is specifying an ASPECT RATIO, and the only way to change an
// image's aspect ratio without distorting it is to cut something off. Until now
// that step happened in some other application, which is to say the workflow
// broke at the exact moment this tool was about to be useful.
//
// Ratios are width / height, so a portrait slot is less than 1.

export const ASPECT_PRESETS = [
  { id: 'free',       label: 'No crop — keep the original shape', ratio: null },
  { id: 'photo35x45', label: 'Passport photo — 3.5 × 4.5 cm',     ratio: 35 / 45 },
  { id: 'photo2x2',   label: 'Square — 2 × 2 in',                 ratio: 1 },
  { id: 'sign35x15',  label: 'Signature — 3.5 × 1.5 cm',          ratio: 35 / 15 },
  { id: 'sign6x2',    label: 'Signature, wide — 6 × 2 cm',        ratio: 3 },
  { id: 'a4',         label: 'A4 page — 210 × 297 mm',            ratio: 210 / 297 }
];

const clamp = (n, low, high) => Math.min(Math.max(n, low), high);

/**
 * Where to cut, in source pixels.
 *
 * Pure geometry on purpose: no canvas, no DOM, no image. That makes the part
 * most likely to be subtly wrong - off-by-one at the edges, a rect that hangs
 * over the boundary, a ratio that drifts - checkable under Node.
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @param {number} ratio    width / height. Falsy means "no crop".
 * @param {{x:number,y:number}} focus  crop CENTRE, normalised 0..1
 * @param {number} zoom     1 = the largest rect of this ratio that fits;
 *                          2 = half that, i.e. twice as close in
 * @returns {{x:number,y:number,width:number,height:number}} always inside bounds
 */
export function planCrop(sourceWidth, sourceHeight, ratio, focus = { x: 0.5, y: 0.5 }, zoom = 1) {
  const full = { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return full;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return full;

  // Largest rect of this ratio that fits inside the source.
  let width = sourceWidth;
  let height = width / ratio;
  if (height > sourceHeight) {
    height = sourceHeight;
    width = height * ratio;
  }

  // Zooming in shrinks the rect. Below 1 would ask for a rect larger than the
  // image, which cannot be honoured without inventing pixels.
  const scale = Math.max(1, Number.isFinite(zoom) ? zoom : 1);
  width = Math.max(1, Math.round(width / scale));
  height = Math.max(1, Math.round(height / scale));

  // Rounding can push either side one pixel past the edge.
  width = Math.min(width, sourceWidth);
  height = Math.min(height, sourceHeight);

  // A missing, null or non-finite focus means "unspecified", which is the
  // CENTRE. Coercing it to 0 instead would silently crop to the top-left corner
  // - a plausible-looking result that is wrong in a way nobody would report.
  const axis = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0.5);

  const centreX = axis(focus?.x) * sourceWidth;
  const centreY = axis(focus?.y) * sourceHeight;

  return {
    x: clamp(Math.round(centreX - width / 2), 0, sourceWidth - width),
    y: clamp(Math.round(centreY - height / 2), 0, sourceHeight - height),
    width,
    height
  };
}

/** Apply a planCrop() rect, returning a new canvas. */
function cropCanvas(source, rect) {
  if (rect.width === source.width && rect.height === source.height
      && rect.x === 0 && rect.y === 0) {
    return source;
  }

  const canvas = document.createElement('canvas');
  canvas.width = rect.width;
  canvas.height = rect.height;

  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // JPEG has no alpha; without this a transparent PNG crops to black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, rect.width, rect.height);
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height,
                    0, 0, rect.width, rect.height);
  return canvas;
}

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

  const decoded = await decodeToCanvas(file);

  // Captured BEFORE cropping, and before release() zeroes anything: "original"
  // means what the user handed us, so the report can honestly say 4000x3000
  // became 350x450 rather than pretending the crop never happened.
  const original = {
    bytes: file.size, name: file.name, type: file.type,
    width: decoded.width, height: decoded.height
  };

  // Crop first, resize second. The other order would scale pixels that are
  // about to be thrown away, and would make maxWidthOrHeight apply to an edge
  // the output does not have.
  const crop = planCrop(decoded.width, decoded.height, preset.aspect, preset.focus, preset.zoom);
  const source = cropCanvas(decoded, crop);
  if (source !== decoded) {
    release(decoded);
    original.cropped = { width: source.width, height: source.height };
  }

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
