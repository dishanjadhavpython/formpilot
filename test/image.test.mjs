// Exercises the band search with a stubbed canvas whose encoder size model is
// monotonic in both pixel count and quality - like a real JPEG encoder.
const ROOT = new URL('..', import.meta.url).href.replace(/\/$/, '');

function makeCanvas(w = 0, h = 0, complexity = 1) {
  const canvas = {
    width: w, height: h, _complexity: complexity,
    getContext() {
      return {
        set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {}, set fillStyle(v) {},
        fillRect() {},
        drawImage(src) { canvas._complexity = src._complexity; }
      };
    },
    toBlob(cb, type, q) {
      const px = canvas.width * canvas.height;
      const bytes = type === 'image/png'
        ? px * 3 * canvas._complexity
        : px * (0.01 + 0.5 * Math.pow(q ?? 0.92, 1.8)) * canvas._complexity;
      cb({ size: Math.max(1, Math.round(bytes)), type });
    }
  };
  return canvas;
}

globalThis.window = globalThis;
globalThis.self = globalThis;
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true }); } catch {}
globalThis.document = { createElement: () => makeCanvas() };

const bic = (await import(`${ROOT}/vendor/browser-image-compression.mjs`)).default;
let sourceSpec = { w: 3000, h: 4000, complexity: 1 };
bic.drawFileInCanvas = async () => [null, makeCanvas(sourceSpec.w, sourceSpec.h, sourceSpec.complexity)];

const { fitToBand, DEFAULT_PRESETS, ASPECT_PRESETS, planCrop } = await import(`${ROOT}/lib/image.js`);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const file = (size, name = 'photo.jpg') => ({ size, name, type: 'image/jpeg' });
const preset = (id) => DEFAULT_PRESETS.find((p) => p.id === id);
const KB = (b) => (b / 1024).toFixed(1) + ' KB';

console.log('\n1. Big phone photo -> passport-photo band (10-200 KB, <=600px)');
sourceSpec = { w: 3000, h: 4000, complexity: 1 };
let r = await fitToBand(file(6_200_000), preset('photo'));
ok('landed in band', r.ok && r.bytes >= 10*1024 && r.bytes <= 200*1024, r.ok ? KB(r.bytes) : r.reason);
ok('longest edge <= 600', Math.max(r.width, r.height) <= 600, `${r.width}x${r.height}`);
ok('reports original dimensions (not zeroed)', r.original.width === 3000 && r.original.height === 4000,
   `${r.original.width}x${r.original.height}`);
ok('percent saved is sane', r.savedPercent > 90 && r.savedPercent < 100, `${r.savedPercent}%`);
ok('quality within bounds', r.quality >= 0.05 && r.quality <= 0.95, `q=${r.quality?.toFixed(3)}`);

console.log('\n2. Same photo -> signature band (4-30 KB, <=300px)');
r = await fitToBand(file(6_200_000), preset('signature'));
ok('landed in band', r.ok && r.bytes >= 4*1024 && r.bytes <= 30*1024, r.ok ? KB(r.bytes) : r.reason);
ok('longest edge <= 300', Math.max(r.width, r.height) <= 300, `${r.width}x${r.height}`);

console.log('\n3. Document band (100-500 KB, <=1600px)');
r = await fitToBand(file(6_200_000), preset('document'));
ok('landed in band', r.ok && r.bytes >= 100*1024 && r.bytes <= 500*1024, r.ok ? KB(r.bytes) : r.reason);

console.log('\n4. Impossible bands are diagnosed, not silently wrong');
sourceSpec = { w: 200, h: 200, complexity: 0.2 };
r = await fitToBand(file(9000), { id:'x', format:'image/jpeg', maxWidthOrHeight:200, minKB:500, maxKB:900 });
ok('tiny source, huge minimum -> TOO_SMALL', !r.ok && r.reason === 'TOO_SMALL', r.reason);
ok('explains which end failed', /below 500 KB|too little detail/.test(r.message ?? ''), '');
ok('still returns a nearest-miss', Boolean(r.best), r.best ? KB(r.best.blob.size) : 'none');
ok('original dims survived release', r.original.width === 200, `w=${r.original.width}`);

sourceSpec = { w: 6000, h: 6000, complexity: 3 };
r = await fitToBand(file(30_000_000), { id:'y', format:'image/jpeg', maxWidthOrHeight:6000, minKB:0.1, maxKB:1 });
ok('huge source, 1 KB ceiling -> TOO_BIG', !r.ok && r.reason === 'TOO_BIG', r.reason);

r = await fitToBand(file(1000), { id:'z', format:'image/jpeg', maxWidthOrHeight:600, minKB:200, maxKB:100 });
ok('min >= max -> INVALID_BAND', !r.ok && r.reason === 'INVALID_BAND', r.reason);

console.log('\n5. Ladder actually descends when quality alone cannot win');
sourceSpec = { w: 4000, h: 4000, complexity: 2.5 };
r = await fitToBand(file(20_000_000), { id:'tight', format:'image/jpeg', maxWidthOrHeight:4000, minKB:20, maxKB:60 });
ok('found the band by shrinking', r.ok, r.ok ? `${r.width}x${r.height} @ ${KB(r.bytes)}` : r.reason);
ok('shrank below the dimension cap', r.ok && Math.max(r.width, r.height) < 4000, `${r.width}x${r.height}`);

console.log('\n6. PNG path (quality argument is ignored by the encoder)');
sourceSpec = { w: 2000, h: 2000, complexity: 0.02 };
r = await fitToBand(file(500_000, 'sig.png'), { id:'p', format:'image/png', maxWidthOrHeight:2000, minKB:20, maxKB:200 });
ok('PNG resolved via dimensions only', r.ok, r.ok ? `${r.width}x${r.height} @ ${KB(r.bytes)}` : r.reason);
ok('no quality reported for PNG', r.ok && r.quality === null, String(r.quality));

console.log('\n7. Search is bounded');
sourceSpec = { w: 3000, h: 4000, complexity: 1 };
r = await fitToBand(file(6_200_000), preset('photo'));
ok('attempts stayed reasonable', r.attempts <= 40, `${r.attempts} encodes`);

console.log('\n8. drawFileInCanvas() may hand back an OffscreenCanvas (real Chrome/Edge/Brave do)');
//
// OffscreenCanvas has convertToBlob(), not toBlob() - and when the source image
// already fits the preset (no rung needs to scale it down), scaleCanvas() hands
// the untouched source straight to toBlob(). If that source came from
// drawFileInCanvas() as an OffscreenCanvas, encoding must still work.
function makeOffscreenCanvas(w, h, complexity = 1) {
  const canvas = {
    width: w, height: h, _complexity: complexity,
    getContext() {
      return {
        set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {}, set fillStyle(v) {},
        fillRect() {},
        drawImage(src) { canvas._complexity = src._complexity; }
      };
    },
    // No toBlob() on purpose - real OffscreenCanvas does not have one.
    convertToBlob({ type, quality }) {
      const px = canvas.width * canvas.height;
      const bytes = type === 'image/png'
        ? px * 3 * canvas._complexity
        : px * (0.01 + 0.5 * Math.pow(quality ?? 0.92, 1.8)) * canvas._complexity;
      return Promise.resolve({ size: Math.max(1, Math.round(bytes)), type });
    }
  };
  return canvas;
}

const realDrawFileInCanvas = bic.drawFileInCanvas;
// A signature-sized source that already fits the signature preset (<=300px), so
// baseScale is 1 and scaleCanvas() returns the OffscreenCanvas untouched.
bic.drawFileInCanvas = async () => [null, makeOffscreenCanvas(300, 100, 0.3)];
r = await fitToBand(file(50_000, 'sig.jpg'), preset('signature'));
ok('encodes via convertToBlob when no scaling is needed', r.ok, r.ok ? KB(r.bytes) : r.reason);
ok('dimensions passed through untouched', r.ok && r.width === 300 && r.height === 100, `${r.width}x${r.height}`);
bic.drawFileInCanvas = realDrawFileInCanvas;

// ============================================================================
console.log('\n6. planCrop — pure geometry, so the edges are checkable');
// ============================================================================
//
// Scaling cannot change an aspect ratio; only cutting can. This is the part of
// cropping most likely to be subtly wrong - a rect that hangs one pixel over the
// boundary, a ratio that drifts as it rounds, a focus point that escapes.

{
  const ratioOf = (r) => r.width / r.height;
  const inside = (r, w, h) => r.x >= 0 && r.y >= 0 && r.x + r.width <= w && r.y + r.height <= h;
  const close = (a, b, tolerance = 0.005) => Math.abs(a - b) <= tolerance;

  const PORTRAIT = 35 / 45;      // the 3.5 x 4.5 cm slot every portal wants

  {
    const r = planCrop(4000, 3000, PORTRAIT);
    ok('a landscape source crops to a portrait shape', close(ratioOf(r), PORTRAIT), ratioOf(r).toFixed(4));
    ok('it takes the full height it can', r.height === 3000, `${r.width}x${r.height}`);
    ok('and stays inside the source', inside(r, 4000, 3000), JSON.stringify(r));
    ok('centred by default', r.x === Math.round((4000 - r.width) / 2), String(r.x));
  }

  {
    const r = planCrop(3000, 4000, 3);      // wide signature strip from a portrait
    ok('a portrait source crops to a wide strip', close(ratioOf(r), 3), ratioOf(r).toFixed(4));
    ok('it takes the full width it can', r.width === 3000, `${r.width}x${r.height}`);
    ok('and stays inside', inside(r, 3000, 4000), JSON.stringify(r));
  }

  // The focus point is where the user dragged to. It must never push the rect
  // over an edge, however far it is pushed.
  for (const [fx, fy] of [[0, 0], [1, 1], [-5, -5], [9, 9], [0.5, 0], [0, 0.5]]) {
    const r = planCrop(4000, 3000, PORTRAIT, { x: fx, y: fy });
    ok(`focus (${fx}, ${fy}) stays inside the image`, inside(r, 4000, 3000), JSON.stringify(r));
  }

  ok('a nonsense focus falls back to the centre',
    planCrop(4000, 3000, PORTRAIT, { x: NaN, y: undefined }).x === planCrop(4000, 3000, PORTRAIT).x);

  {
    const one = planCrop(4000, 3000, 1);
    const two = planCrop(4000, 3000, 1, { x: 0.5, y: 0.5 }, 2);
    ok('zoom 2 halves each edge', two.width === Math.round(one.width / 2), `${one.width} -> ${two.width}`);
    ok('zoom keeps the ratio', close(ratioOf(two), 1), ratioOf(two).toFixed(4));
    ok('zoom below 1 is ignored, not honoured',
      planCrop(4000, 3000, 1, { x: 0.5, y: 0.5 }, 0.25).width === one.width,
      'a rect larger than the image would need invented pixels');
    ok('a huge zoom still yields a usable rect',
      planCrop(4000, 3000, 1, { x: 0.5, y: 0.5 }, 100000).width >= 1);
  }

  // "No crop" has to mean exactly the whole frame, or an untouched image would
  // still be re-drawn through a canvas for nothing.
  for (const ratio of [null, undefined, 0, -1, NaN, Infinity, 'photo']) {
    const r = planCrop(4000, 3000, ratio);
    ok(`ratio ${String(ratio)} means the full frame`,
      r.x === 0 && r.y === 0 && r.width === 4000 && r.height === 3000, JSON.stringify(r));
  }

  ok('a degenerate source is handled', planCrop(0, 0, PORTRAIT).width === 0);
  ok('a 1x1 source is handled', planCrop(1, 1, PORTRAIT).width === 1);

  // Every shipped shape must survive both orientations without escaping.
  for (const aspect of ASPECT_PRESETS) {
    if (!aspect.ratio) continue;
    const wide = planCrop(4000, 3000, aspect.ratio);
    const tall = planCrop(3000, 4000, aspect.ratio);
    ok(`${aspect.id} fits a landscape source`,
      inside(wide, 4000, 3000) && close(ratioOf(wide), aspect.ratio), JSON.stringify(wide));
    ok(`${aspect.id} fits a portrait source`,
      inside(tall, 3000, 4000) && close(ratioOf(tall), aspect.ratio), JSON.stringify(tall));
  }

  ok('the "no crop" preset really carries no ratio',
    ASPECT_PRESETS.find((a) => a.id === 'free')?.ratio === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
