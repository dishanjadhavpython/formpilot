// FormPilot - cleaning up a photo before OCR reads it.
//
// ============================================================================
// WHY THIS EXISTS, AND WHAT IT DELIBERATELY DOES NOT DO
// ============================================================================
//
// Every real input to this feature is a phone photo of a card lying on a desk:
// held at an angle, lit unevenly, and often smaller than Tesseract wants. The
// engine's own accuracy on that is meaningfully worse than on a flat scan, and
// PLAN.md has called pre-processing the biggest available win since Phase 4.
//
// The obvious move - threshold everything to hard black and white - is the
// wrong one, and it is worth being precise about why. Tesseract 4/5 is an LSTM
// engine. It performs its own thresholding internally, and it was trained on
// rendered text with antialiasing intact. Handing it a hard binary image throws
// away the greyscale edge information the network actually uses, and on a photo
// with uneven lighting a GLOBAL threshold additionally eats whole regions -
// exactly the case pre-processing was supposed to help with.
//
// So what is fed to the engine is greyscale, contrast-normalised, deskewed and
// upscaled. Binarisation happens here too, but only INTERNALLY, as the input to
// skew estimation, where a clean two-level image is genuinely what the algorithm
// needs. That distinction is the whole design.
//
// ============================================================================
// TESTABILITY
// ============================================================================
//
// Everything algorithmic below is a pure function over typed arrays: no canvas,
// no DOM, no image. Otsu's threshold, the projection score and the skew search
// can therefore be driven from Node against synthetic images whose correct
// answer is known by construction. Only the last function touches a canvas.

// --- Greyscale and histograms -----------------------------------------------

/**
 * Rec. 601 luma. Not a plain mean: the eye is far more sensitive to green, and
 * text printed in colour on a card separates from its background much better
 * under a weighted conversion.
 *
 * @param {Uint8ClampedArray} rgba
 * @returns {Uint8ClampedArray} one byte per pixel
 */
export function toGrey(rgba) {
  const grey = new Uint8ClampedArray(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    grey[p] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  }
  return grey;
}

/** @returns {Uint32Array} 256 bins */
export function histogram(grey) {
  const bins = new Uint32Array(256);
  for (let i = 0; i < grey.length; i++) bins[grey[i]]++;
  return bins;
}

/**
 * Otsu's threshold: the level that maximises between-class variance.
 *
 * Classic, parameter-free, and computable in one pass over a 256-bin
 * histogram. It assumes the image is genuinely bimodal - ink and paper - which
 * is true of an ID card and is why this is used for skew estimation rather than
 * for what the engine finally sees.
 *
 * @param {Uint32Array} bins
 * @returns {number} 0..255; pixels <= this are ink
 */
export function otsuThreshold(bins) {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    total += bins[i];
    sum += i * bins[i];
  }
  if (total === 0) return 127;

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t++) {
    backgroundWeight += bins[t];
    if (backgroundWeight === 0) continue;

    const foregroundWeight = total - backgroundWeight;
    if (foregroundWeight === 0) break;

    backgroundSum += t * bins[t];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (sum - backgroundSum) / foregroundWeight;

    const between = backgroundWeight * foregroundWeight
      * (backgroundMean - foregroundMean) * (backgroundMean - foregroundMean);

    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}

/**
 * Percentile contrast stretch, as a 256-entry lookup table.
 *
 * A phone photo of a white card is rarely white: it is grey, or yellow under a
 * bulb, and the ink is rarely black. Stretching the actual range onto the full
 * one recovers the separation the engine needs. Percentiles rather than
 * min/max, because a single blown-out highlight or one dust speck would
 * otherwise define the whole range and the stretch would do nothing.
 *
 * @param {Uint32Array} bins
 * @param {number} cut  fraction ignored at each end (0.02 = 2%)
 * @returns {Uint8ClampedArray} LUT
 */
export function contrastLut(bins, cut = 0.02) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += bins[i];

  const lut = new Uint8ClampedArray(256);
  if (total === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  const want = Math.max(0, Math.min(0.49, cut)) * total;

  let low = 0;
  for (let i = 0, seen = 0; i < 256; i++) {
    seen += bins[i];
    if (seen > want) { low = i; break; }
  }

  let high = 255;
  for (let i = 255, seen = 0; i >= 0; i--) {
    seen += bins[i];
    if (seen > want) { high = i; break; }
  }

  // A flat image (blank page, or a photo of a wall) has nothing to stretch.
  // Scaling a one-level range by 255 would turn sensor noise into a barcode.
  if (high - low < 8) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }

  const scale = 255 / (high - low);
  for (let i = 0; i < 256; i++) lut[i] = (i - low) * scale;
  return lut;
}

// --- Skew -------------------------------------------------------------------

// Beyond this, a "skewed document" is really a rotated one, and the projection
// method stops being reliable - the search would happily return a confident
// wrong answer on a portrait-orientation card.
export const MAX_SKEW_DEGREES = 12;

/**
 * How well do the ink pixels line up into rows at this shear?
 *
 * When text lines are horizontal, every row is either dense with ink or empty,
 * so the row totals are spiky and their sum of squares is large. Tilt the same
 * ink and each line smears across many rows, flattening the totals. Maximising
 * this score therefore finds the angle at which the text is level.
 *
 * Sum of squares rather than variance: the total ink is identical at every
 * angle - the same pixels are only re-binned - so the mean is constant and the
 * two orderings agree. One less division per angle.
 *
 * A shear (`row = y - x*tan θ`) rather than a true rotation, which is both
 * cheaper and, below ~15 degrees, indistinguishable for this purpose.
 *
 * @param {Int32Array} xs   ink pixel columns
 * @param {Int32Array} ys   ink pixel rows
 * @param {number} tan      tan of the candidate angle
 * @param {number} rows     size of the accumulator
 * @param {number} offset   added to each row index to keep it non-negative
 * @param {Float64Array} scratch  reused accumulator, `rows` long
 */
export function projectionScore(xs, ys, tan, rows, offset, scratch) {
  scratch.fill(0);

  for (let i = 0; i < xs.length; i++) {
    const row = (ys[i] - xs[i] * tan + offset) | 0;
    if (row >= 0 && row < rows) scratch[row]++;
  }

  let score = 0;
  for (let r = 0; r < rows; r++) score += scratch[r] * scratch[r];
  return score;
}

/**
 * Estimate the skew of a binary image, in degrees.
 *
 * Positive means text slopes DOWN to the right, so the correction is a rotation
 * by minus this angle.
 *
 * Coarse-to-fine: a 1-degree sweep over the whole range, then a 0.1-degree
 * sweep around the winner. Two passes cost about a tenth of what a single
 * 0.1-degree sweep would.
 *
 * @param {Uint8Array} binary  1 = ink, 0 = paper
 * @param {number} width
 * @param {number} height
 * @returns {number} degrees, 0 if there is not enough ink to judge
 */
export function estimateSkew(binary, width, height) {
  // Collect ink coordinates once. Every candidate angle re-bins this same set,
  // so walking the full image per angle would be pure waste.
  let count = 0;
  for (let i = 0; i < binary.length; i++) if (binary[i]) count++;

  // Too little ink to be text; too much and the "ink" is a dark background.
  const ratio = count / (width * height);
  if (count < 64 || ratio > 0.9) return 0;

  const xs = new Int32Array(count);
  const ys = new Int32Array(count);
  for (let y = 0, i = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) {
      if (binary[p]) { xs[i] = x; ys[i] = y; i++; }
    }
  }

  const maxTan = Math.tan((MAX_SKEW_DEGREES * Math.PI) / 180);
  const offset = Math.ceil(width * maxTan) + 1;
  const rows = height + 2 * offset;
  const scratch = new Float64Array(rows);

  const search = (from, to, step) => {
    let bestAngle = 0;
    let bestScore = -1;
    for (let angle = from; angle <= to + 1e-9; angle += step) {
      const score = projectionScore(xs, ys, Math.tan((angle * Math.PI) / 180), rows, offset, scratch);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }
    return bestAngle;
  };

  const coarse = search(-MAX_SKEW_DEGREES, MAX_SKEW_DEGREES, 1);
  const fine = search(Math.max(-MAX_SKEW_DEGREES, coarse - 1),
                      Math.min(MAX_SKEW_DEGREES, coarse + 1), 0.1);

  // Rounding keeps a meaningless 0.03-degree "correction" from costing a full
  // resample of a large image for no gain.
  return Math.round(fine * 10) / 10;
}

/** Threshold a greyscale buffer into 1 = ink, 0 = paper. */
export function binarise(grey, threshold) {
  const binary = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++) binary[i] = grey[i] <= threshold ? 1 : 0;
  return binary;
}

// --- The canvas pipeline ----------------------------------------------------

// Tesseract wants a capital roughly 30px tall. Card text photographed at normal
// phone distance lands well under that, and upscaling before recognition is one
// of the few interventions that reliably helps an LSTM engine.
export const TARGET_MIN_HEIGHT = 1000;

// Skew is estimated on a downscaled copy. The angle of a page does not change
// with resolution, and the search is linear in ink pixels.
const SKEW_WORK_WIDTH = 800;

const canvasOf = (width, height) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

function drawScaled(source, width, height) {
  const canvas = canvasOf(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * Clean up an image for OCR.
 *
 * @param {HTMLCanvasElement|OffscreenCanvas|ImageBitmap} source
 * @param {{deskew?:boolean, contrast?:boolean, upscale?:boolean}} options
 * @returns {{canvas:HTMLCanvasElement, applied:{rotated:number, scaled:number, contrast:boolean}}}
 */
export function preprocessForOcr(source, options = {}) {
  const { deskew = true, contrast = true, upscale = true } = options;

  const applied = { rotated: 0, scaled: 1, contrast: false };

  // 1. Upscale first, so the deskew resample and the engine both see the larger
  //    image and only one interpolation happens after it.
  let scale = 1;
  if (upscale && source.height > 0 && source.height < TARGET_MIN_HEIGHT) {
    // Whole-number factors only: they resample far more cleanly than 1.37x, and
    // 3x is already past the point of recovering real detail.
    scale = Math.min(3, Math.max(1, Math.floor(TARGET_MIN_HEIGHT / source.height)));
  }
  applied.scaled = scale;

  let working = drawScaled(source,
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale)));

  // 2. Greyscale + contrast, in one pass over the pixels.
  const context = working.getContext('2d', { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, working.width, working.height);
  const grey = toGrey(pixels.data);

  if (contrast) {
    const lut = contrastLut(histogram(grey));
    // An identity LUT means the image had nothing to stretch; say so honestly
    // rather than claiming a correction that did nothing.
    applied.contrast = lut[0] !== 0 || lut[255] !== 255 || lut[128] !== 128;
    for (let i = 0; i < grey.length; i++) grey[i] = lut[grey[i]];
  }

  for (let i = 0, p = 0; i < pixels.data.length; i += 4, p++) {
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = grey[p];
    pixels.data[i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);

  // 3. Deskew. Estimated on a small binarised copy; applied to the greyscale.
  if (deskew) {
    const angle = estimateSkewOf(working, grey);
    if (Math.abs(angle) >= 0.2) {
      working = rotateCanvas(working, -angle);
      applied.rotated = angle;
    }
  }

  return { canvas: working, applied };
}

/** Binarise a downscaled copy and measure its skew. */
function estimateSkewOf(canvas, greyFullSize) {
  const scale = Math.min(1, SKEW_WORK_WIDTH / canvas.width);

  let grey = greyFullSize;
  let width = canvas.width;
  let height = canvas.height;

  if (scale < 1) {
    const small = drawScaled(canvas, Math.max(1, Math.round(canvas.width * scale)),
                                     Math.max(1, Math.round(canvas.height * scale)));
    const context = small.getContext('2d', { willReadFrequently: true });
    const data = context.getImageData(0, 0, small.width, small.height);
    grey = toGrey(data.data);
    width = small.width;
    height = small.height;
    small.width = small.height = 0;      // release
  }

  return estimateSkew(binarise(grey, otsuThreshold(histogram(grey))), width, height);
}

/**
 * Rotate about the centre onto a canvas large enough to hold the result.
 * The new corners are paper-white, not transparent: a transparent margin
 * composites to black and the engine reads a black frame as ink.
 */
function rotateCanvas(source, degrees) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));

  const width = Math.ceil(source.width * cos + source.height * sin);
  const height = Math.ceil(source.width * sin + source.height * cos);

  const canvas = canvasOf(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);

  context.translate(width / 2, height / 2);
  context.rotate(radians);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, -source.width / 2, -source.height / 2);

  source.width = source.height = 0;      // release the pre-rotation copy
  return canvas;
}

/** A sentence describing what was actually done, or null if nothing was. */
export function describePreprocessing(applied) {
  const parts = [];
  if (applied.scaled > 1) parts.push(`enlarged ${applied.scaled}x`);
  if (applied.rotated) parts.push(`straightened ${Math.abs(applied.rotated).toFixed(1)}°`);
  if (applied.contrast) parts.push('contrast evened out');
  return parts.length ? `Cleaned up first: ${parts.join(', ')}.` : null;
}
