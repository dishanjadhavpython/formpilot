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

const { fitToBand, DEFAULT_PRESETS } = await import(`${ROOT}/lib/image.js`);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
