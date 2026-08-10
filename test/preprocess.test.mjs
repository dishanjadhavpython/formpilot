// FormPilot - image clean-up before OCR.
//
//   node test/preprocess.test.mjs
//
// The whole point of keeping this module's algorithms pure - typed arrays in,
// numbers out, no canvas anywhere - is that they can be driven against
// SYNTHETIC images whose right answer is known by construction. A page sheared
// by exactly 5 degrees has a skew of exactly 5 degrees, and nothing about that
// needs a browser, a photo, or a human squinting at a preview.
//
// That matters more here than in most of this project, because a wrong answer
// from pre-processing does not look like a bug. It looks like OCR being bad.

import {
  toGrey, histogram, otsuThreshold, contrastLut,
  binarise, estimateSkew, projectionScore, describePreprocessing,
  MAX_SKEW_DEGREES
} from '../lib/preprocess.js';

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

// ============================================================================
console.log('\n1. Greyscale is weighted, not averaged');
// ============================================================================

{
  // Rec. 601: the eye is far more sensitive to green, and text printed in
  // colour separates from its background much better under a weighted mix.
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255,      // red
    0, 255, 0, 255,      // green
    0, 0, 255, 255,      // blue
    255, 255, 255, 255,  // white
    0, 0, 0, 255         // black
  ]);
  const grey = toGrey(rgba);

  ok('one byte out per pixel in', grey.length === 5, String(grey.length));
  ok('white stays white', grey[3] === 255);
  ok('black stays black', grey[4] === 0);
  ok('green is the brightest primary', grey[1] > grey[0] && grey[1] > grey[2],
    `r=${grey[0]} g=${grey[1]} b=${grey[2]}`);
  ok('blue is the darkest primary', grey[2] < grey[0]);
  ok('it is not a plain mean', grey[0] !== 85, 'a mean would put every primary at 85');
}

// ============================================================================
console.log('\n2. Otsu finds the valley between ink and paper');
// ============================================================================

{
  const bimodal = new Uint32Array(256);
  for (let i = 20; i < 40; i++) bimodal[i] = 500;      // ink
  for (let i = 200; i < 240; i++) bimodal[i] = 2000;   // paper

  const t = otsuThreshold(bimodal);
  ok('the threshold separates the two modes', t >= 39 && t < 200, String(t));

  // The convention has to match binarise(), which treats <= t as ink. Getting
  // this off by one inverts nothing visible but shifts every skew estimate.
  const grey = new Uint8ClampedArray([25, 30, 35, 210, 220, 235]);
  const binary = binarise(grey, t);
  ok('every ink pixel binarises as ink',
    binary[0] === 1 && binary[1] === 1 && binary[2] === 1, Array.from(binary).join(''));
  ok('every paper pixel binarises as paper',
    binary[3] === 0 && binary[4] === 0 && binary[5] === 0);

  ok('binarise is inclusive at the threshold',
    binarise(new Uint8ClampedArray([128, 129]), 128).join('') === '10');

  ok('an empty histogram gives a neutral answer', otsuThreshold(new Uint32Array(256)) === 127);

  const flat = new Uint32Array(256);
  flat[77] = 1000;
  ok('a single-level image does not throw', Number.isFinite(otsuThreshold(flat)));
}

// ============================================================================
console.log('\n3. Contrast stretch, and when to leave well alone');
// ============================================================================

{
  // A phone photo of a white card is grey, or yellow under a bulb, and the ink
  // is never black. Stretching the real range recovers the separation.
  const washed = new Uint32Array(256);
  for (let i = 90; i < 170; i++) washed[i] = 100;

  const lut = contrastLut(washed);
  ok('the dark end maps to black', lut[90] <= 4, String(lut[90]));
  ok('the light end maps to white', lut[169] >= 250, String(lut[169]));
  ok('the middle stays in the middle', Math.abs(lut[130] - 128) <= 6, String(lut[130]));
  ok('the LUT is monotonic',
    Array.from(lut).every((v, i, a) => i === 0 || v >= a[i - 1]));

  // One blown highlight must not define the range, or the stretch does nothing.
  const withOutlier = new Uint32Array(256);
  for (let i = 90; i < 170; i++) withOutlier[i] = 100;
  withOutlier[255] = 3;
  ok('a handful of outlying pixels are ignored',
    contrastLut(withOutlier)[169] >= 250, String(contrastLut(withOutlier)[169]));

  // Scaling a one-level range by 255 turns sensor noise into a barcode.
  const flat = new Uint32Array(256);
  flat[128] = 10000;
  const flatLut = contrastLut(flat);
  ok('a flat image is left alone', flatLut[0] === 0 && flatLut[128] === 128 && flatLut[255] === 255);

  const empty = contrastLut(new Uint32Array(256));
  ok('an empty histogram is left alone', empty[0] === 0 && empty[255] === 255);
}

// ============================================================================
console.log('\n4. Skew: recovering an angle we put in on purpose');
// ============================================================================

/** Text-like lines sheared by `degrees` — positive slopes down to the right. */
function page(width, height, degrees, { spacing = 24, thickness = 6, margin = 40 } = {}) {
  const tan = Math.tan((degrees * Math.PI) / 180);
  const image = new Uint8Array(width * height);
  for (let base = margin; base < height - margin; base += spacing) {
    for (let x = margin; x < width - margin; x++) {
      // A ragged right edge, so the lines are not identical rectangles.
      if (x > width - margin - ((base * 37) % 120)) continue;
      const top = Math.round(base + x * tan);
      for (let t = 0; t < thickness; t++) {
        const y = top + t;
        if (y >= 0 && y < height) image[y * width + x] = 1;
      }
    }
  }
  return image;
}

{
  // The fine sweep steps 0.1 degrees, so 0.15 is the tightest honest tolerance.
  const TOLERANCE = 0.15;
  let worst = 0;

  for (const truth of [-10, -7.5, -5, -3, -1.5, -0.5, 0, 0.5, 1.5, 3, 5, 7.5, 10]) {
    const got = estimateSkew(page(600, 400, truth), 600, 400);
    const error = Math.abs(got - truth);
    worst = Math.max(worst, error);
    ok(`skew ${String(truth).padStart(5)}° recovered`, error <= TOLERANCE, `got ${got}°`);
  }
  ok('worst error is within one search step', worst <= TOLERANCE, `${worst.toFixed(2)}°`);

  // The sign convention is the thing most likely to be silently backwards, and
  // backwards means every tilted photo gets tilted twice as far.
  ok('a positive skew is reported positive', estimateSkew(page(600, 400, 6), 600, 400) > 0);
  ok('a negative skew is reported negative', estimateSkew(page(600, 400, -6), 600, 400) < 0);

  ok('it works on a tall narrow page', Math.abs(estimateSkew(page(300, 800, 4), 300, 800) - 4) <= 0.3);
  ok('it works with sparse text',
    Math.abs(estimateSkew(page(600, 400, 3, { spacing: 90, thickness: 3 }), 600, 400) - 3) <= 0.3);
}

// ============================================================================
console.log('\n5. Skew: refusing to answer when it cannot know');
// ============================================================================

{
  // A confident wrong angle is worse than no angle: it resamples the image and
  // makes the reading worse, with nothing to blame it on.
  ok('a blank page has no skew', estimateSkew(new Uint8Array(600 * 400), 600, 400) === 0);
  ok('an all-ink image has no skew',
    estimateSkew(new Uint8Array(600 * 400).fill(1), 600, 400) === 0,
    'that is a dark background, not text');
  ok('a few specks are not text',
    estimateSkew(Uint8Array.from({ length: 100 }, (_, i) => (i < 3 ? 1 : 0)), 10, 10) === 0);
  ok('an empty image does not throw', estimateSkew(new Uint8Array(0), 0, 0) === 0);

  ok('the answer never leaves the searched range',
    Math.abs(estimateSkew(page(600, 400, 11.5), 600, 400)) <= MAX_SKEW_DEGREES);
  ok('the range is a sane size', MAX_SKEW_DEGREES > 5 && MAX_SKEW_DEGREES < 25,
    `${MAX_SKEW_DEGREES}°`);
}

// ============================================================================
console.log('\n6. The projection score is highest when the text is level');
// ============================================================================

{
  const width = 400, height = 300;
  const flatPage = page(width, height, 0);

  const xs = [];
  const ys = [];
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) if (flatPage[p]) { xs.push(x); ys.push(y); }
  }
  const inkX = Int32Array.from(xs);
  const inkY = Int32Array.from(ys);

  const offset = 200;
  const rows = height + 2 * offset;
  const scratch = new Float64Array(rows);
  const score = (deg) => projectionScore(inkX, inkY, Math.tan((deg * Math.PI) / 180), rows, offset, scratch);

  const level = score(0);
  ok('level beats a 5° shear', level > score(5), `${level.toFixed(0)} vs ${score(5).toFixed(0)}`);
  ok('level beats a -5° shear', level > score(-5));
  ok('level beats a 1° shear', level > score(1));
  ok('the score falls off monotonically either way',
    score(1) > score(3) && score(3) > score(6) && score(-1) > score(-3));

  // Total ink is identical at every angle - only the binning changes - which is
  // what makes a plain sum of squares comparable across angles.
  const total = (deg) => {
    scratch.fill(0);
    projectionScore(inkX, inkY, Math.tan((deg * Math.PI) / 180), rows, offset, scratch);
    return scratch.reduce((a, b) => a + b, 0);
  };
  ok('no ink is lost off the ends of the accumulator',
    total(0) === inkX.length && total(10) === inkX.length && total(-10) === inkX.length,
    `${total(0)} / ${total(10)} / ${inkX.length}`);
}

// ============================================================================
console.log('\n7. Reporting what was done');
// ============================================================================

{
  ok('doing nothing reports nothing',
    describePreprocessing({ rotated: 0, scaled: 1, contrast: false }) === null,
    'an unconditional "cleaned up!" would be noise');

  const all = describePreprocessing({ rotated: -3.25, scaled: 2, contrast: true });
  ok('an enlargement is named', /enlarged 2x/.test(all), all);
  ok('a rotation is named with its size', /straightened 3\.3°/.test(all), all);
  ok('the sign is not shown to the user', !/-3/.test(all), all);
  ok('a contrast change is named', /contrast/.test(all), all);

  ok('only what happened is named',
    describePreprocessing({ rotated: 0, scaled: 2, contrast: false }) === 'Cleaned up first: enlarged 2x.');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
