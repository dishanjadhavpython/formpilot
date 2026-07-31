// FormPilot - on-device OCR (tesseract.js, fully local)
//
// ============================================================================
// MAKING TESSERACT.JS MV3-SAFE
// ============================================================================
//
// Out of the box, tesseract.js reaches the network in THREE separate places,
// every one of which is a Manifest V3 violation. All three are overridden below:
//
//   1. workerPath  - defaults to jsDelivr. Worse, `workerBlobURL` defaults to
//                    true, which wraps the worker in
//                      new Worker(URL.createObjectURL(new Blob([...])))
//                    and MV3's `script-src 'self'` blocks blob: workers.
//                    Fixed by pointing workerPath at the vendored file AND
//                    setting workerBlobURL:false, which takes the plain
//                    `new Worker(path)` branch.
//
//   2. corePath    - the worker calls importScripts() on the WASM core, which
//                    defaults to jsDelivr. Note the resolution rule: if
//                    corePath ends in ".js" tesseract uses that exact file and
//                    skips SIMD feature detection entirely. We rely on that, so
//                    only ONE core variant has to be vendored instead of six.
//
//   3. langPath    - the traineddata, again from a CDN. Pointed at our folder;
//                    the worker then fetches `<langPath>/eng.traineddata.gz`.
//
// Also required: manifest.json declares 'wasm-unsafe-eval' in the extension
// CSP. Without it Chrome refuses to instantiate the WASM module at all. That
// directive permits compiling bundled WebAssembly; it does not permit eval()
// or remote code.
//
// Nothing here touches the network. Verify it yourself: open DevTools on the
// options page, filter the Network tab by "tesseract", and confirm every
// request is a chrome-extension:// URL.

import Tesseract from '../vendor/tesseract/tesseract.esm.min.js';

const VENDOR = 'vendor/tesseract';

// OEM.LSTM_ONLY. The vendored core is the -lstm build and the traineddata is
// the integerised "best" LSTM model, so the legacy engine is neither shipped
// nor requested.
const LSTM_ONLY = 1;

let workerPromise = null;   // the engine is expensive to start; reuse it

/**
 * Start (or reuse) the OCR worker. First call pays for loading ~6.8 MB of
 * WASM + language data from local disk, which is why the caller shows progress.
 */
function getWorker(onProgress) {
  if (workerPromise) return workerPromise;

  const base = chrome.runtime.getURL(VENDOR);

  workerPromise = Tesseract.createWorker('eng', LSTM_ONLY, {
    workerPath: `${base}/worker.min.js`,
    corePath: `${base}/tesseract-core-simd-lstm.wasm.js`,
    langPath: base,
    workerBlobURL: false,     // MV3: no blob: workers. See the note above.
    gzip: true,               // our traineddata ships gzipped
    legacyCore: false,
    legacyLang: false,
    logger: (message) => {
      if (typeof onProgress === 'function') onProgress(message);
    }
  }).catch((err) => {
    workerPromise = null;     // let a later attempt retry from scratch
    throw err;
  });

  return workerPromise;
}

/** Release the engine and its memory. */
export async function terminateOcr() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    /* already gone */
  }
}

/**
 * Recognise text in an image.
 * @param {File|Blob|string} image
 * @param {(m:{status:string, progress:number})=>void} onProgress
 * @returns {Promise<{text:string, confidence:number, lines:Array}>}
 */
export async function recognise(image, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(image);

  return {
    text: data.text ?? '',
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    lines: (data.lines ?? []).map((line) => ({
      text: (line.text ?? '').trim(),
      confidence: line.confidence ?? 0
    })).filter((line) => line.text)
  };
}

// ============================================================================
// Field extraction
// ============================================================================
//
// OCR output is messy: stray punctuation, 0/O and 1/I confusion, labels glued
// to values. These heuristics are deliberately conservative - it is far better
// to extract nothing and let the user type it than to silently fill a wrong PAN
// into a form. Everything extracted is shown for review before it is saved.

// PAN is exactly 5 letters, 4 digits, 1 letter.
const PAN_RE = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/;

// OCR routinely confuses these in a field that should be all digits or all
// letters. Only applied when a near-miss looks like a PAN.
const TO_DIGIT = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const TO_LETTER = { '0': 'O', '1': 'I', '2': 'Z', '5': 'S', '8': 'B', '6': 'G' };

const DATE_RES = [
  /\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\b/,          // dd/mm/yyyy
  /\b(\d{4})[\/\-.](\d{2})[\/\-.](\d{2})\b/           // yyyy-mm-dd
];

// Matched per line, with spaces/hyphens only as separators - NOT \s, which
// includes newlines. Allowing \s let a match start on a preceding line's year
// ("...1999" + newline + "1234 5678") and report the middle group as the last
// four digits, which is both wrong and silent. The lookarounds stop a partial
// match inside a longer digit run.
const AADHAAR_RE = /(?<!\d)(\d{4})[ -]?(\d{4})[ -]?(\d{4})(?!\d)/;

// Dates are stripped before the Aadhaar scan for the same reason.
const DATE_LIKE_RE = /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g;

// Lines that are labels, not values.
const LABEL_RE = /(income\s*tax|government|govt|department|permanent\s*account|father|mother|signature|date\s*of\s*birth|dob|male|female|gender|address|aadhaar|aadhar|unique\s*identification|authority|india|number|card)/i;

const NAME_LINE_RE = /^[A-Z][A-Z\s.'-]{3,48}$/;

function normaliseUpper(text) {
  return text.toUpperCase().replace(/[^A-Z0-9\s\/\-.]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Repair a token that is nearly a PAN but has OCR digit/letter confusion. */
function repairPan(token) {
  if (token.length !== 10) return null;

  const chars = [...token];
  for (let i = 0; i < 10; i++) {
    const wantLetter = i < 5 || i === 9;
    const c = chars[i];
    if (wantLetter && /[0-9]/.test(c)) chars[i] = TO_LETTER[c] ?? c;
    else if (!wantLetter && /[A-Z]/.test(c)) chars[i] = TO_DIGIT[c] ?? c;
  }
  const repaired = chars.join('');
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(repaired) ? repaired : null;
}

export function extractPan(text) {
  const upper = normaliseUpper(text);

  const direct = PAN_RE.exec(upper);
  if (direct) return { value: direct[1], repaired: false };

  // Try repairing any 10-character alphanumeric run.
  for (const token of upper.split(/\s+/)) {
    if (token.length !== 10 || !/^[A-Z0-9]+$/.test(token)) continue;
    const repaired = repairPan(token);
    if (repaired) return { value: repaired, repaired: true };
  }
  return null;
}

/** Dates, returned as yyyy-mm-dd so they drop straight into <input type=date>. */
export function extractDob(text) {
  const upper = normaliseUpper(text);

  for (const regex of DATE_RES) {
    const match = regex.exec(upper);
    if (!match) continue;

    let year, month, day;
    if (match[1].length === 4) [, year, month, day] = match;
    else [, day, month, year] = match;

    const y = Number(year), m = Number(month), d = Number(day);
    const thisYear = new Date().getFullYear();

    // Reject nonsense rather than filling a bad date.
    if (m < 1 || m > 12 || d < 1 || d > 31) continue;
    if (y < 1900 || y > thisYear) continue;

    return { value: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }
  return null;
}

/**
 * Aadhaar: keep only the last four digits, never the full number.
 * Scans line by line, because the number is printed on its own line and a
 * cross-line match picks up the wrong digits (see AADHAAR_RE above).
 */
export function extractAadhaar(text) {
  for (const raw of String(text).split(/[\r\n]+/)) {
    const line = raw.replace(DATE_LIKE_RE, ' ').replace(/[^\d ]/g, ' ');
    const match = AADHAAR_RE.exec(line);
    if (match) return { value: `XXXX XXXX ${match[3]}`, masked: true };
  }
  return null;
}

/**
 * The name line. Heuristic: the longest all-caps line that is not a known
 * label, does not contain digits, and sits near the top of the card.
 */
export function extractName(lines) {
  const candidates = [];

  for (const line of lines.slice(0, 12)) {
    const text = line.text.trim().replace(/\s+/g, ' ');
    if (text.length < 4 || text.length > 48) continue;
    if (/\d/.test(text)) continue;
    if (LABEL_RE.test(text)) continue;
    if (!NAME_LINE_RE.test(text)) continue;

    candidates.push({ value: text, confidence: line.confidence });
  }
  if (candidates.length === 0) return null;

  // Prefer the most confident; break ties by length.
  candidates.sort((a, b) => (b.confidence - a.confidence) || (b.value.length - a.value.length));
  return candidates[0];
}

/**
 * Run every heuristic over one OCR result.
 * @returns {Array<{key:string, value:string, note?:string}>}
 */
export function extractFields({ text, lines }) {
  const found = [];

  const pan = extractPan(text);
  if (pan) {
    found.push({
      key: 'pan', value: pan.value,
      note: pan.repaired ? 'Character confusion was corrected — check this one carefully.' : null
    });
  }

  const dob = extractDob(text);
  if (dob) found.push({ key: 'dob', value: dob.value });

  const aadhaar = extractAadhaar(text);
  if (aadhaar) found.push({ key: 'aadhaarMasked', value: aadhaar.value, note: 'Only the last 4 digits are kept.' });

  const name = extractName(lines ?? []);
  if (name) found.push({ key: 'fullName', value: name.value, note: 'Best guess at the name line.' });

  return found;
}
