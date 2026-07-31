const ROOT = new URL('..', import.meta.url).href.replace(/\/$/, '');
globalThis.window = globalThis;
globalThis.self = globalThis;
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true }); } catch {}
globalThis.document = { createElement: () => ({}) };
globalThis.chrome = { runtime: { getURL: (p) => `chrome-extension://fake/${p}` } };

const { extractPan, extractDob, extractAadhaar, extractName, extractFields } =
  await import(`${ROOT}/lib/ocr.js`);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };

console.log('\n1. PAN extraction');
ok('clean PAN', extractPan('Permanent Account Number ABCDE1234F')?.value === 'ABCDE1234F');
ok('PAN in noisy card text',
   extractPan('INCOME TAX DEPARTMENT\nGOVT OF INDIA\nABCDE1234F\nDISHAN JADHAV')?.value === 'ABCDE1234F');
let r = extractPan('Account No ABCDE1Z34F');
ok('repairs Z->2 in digit block', r?.value === 'ABCDE1234F' && r.repaired === true, r?.value);
r = extractPan('ABCDEI234F');
ok('repairs I->1 in digit block', r?.value === 'ABCDE1234F' && r.repaired === true, r?.value);
r = extractPan('ABCDE1234O');   // trailing O should become a letter... already is
ok('rejects true garbage', extractPan('HELLO WORLD 12345') === null);
ok('rejects 9-char token', extractPan('ABCDE123F') === null);

console.log('\n2. Date of birth');
ok('dd/mm/yyyy', extractDob('DOB 02/04/1999')?.value === '1999-04-02', extractDob('DOB 02/04/1999')?.value);
ok('dd-mm-yyyy', extractDob('Date of Birth 15-08-1990')?.value === '1990-08-15');
ok('yyyy-mm-dd', extractDob('1999-04-02')?.value === '1999-04-02');
ok('rejects month 13', extractDob('45/13/1999') === null);
ok('rejects future year', extractDob('02/04/2099') === null);
ok('rejects year 1850', extractDob('02/04/1850') === null);

console.log('\n3. Aadhaar is masked, never stored whole');
r = extractAadhaar('Aadhaar 1234 5678 9012');
ok('returns masked form', r?.value === 'XXXX XXXX 9012', r?.value);
ok('full number absent from output', !String(r?.value).includes('5678'));
ok('unspaced digits also masked', extractAadhaar('123456789012')?.value === 'XXXX XXXX 9012');

console.log('\n4. Name line heuristic');
const panLines = [
  { text: 'INCOME TAX DEPARTMENT', confidence: 92 },
  { text: 'GOVT. OF INDIA', confidence: 90 },
  { text: 'DISHAN JADHAV', confidence: 88 },
  { text: 'RAMESH JADHAV', confidence: 85 },
  { text: '02/04/1999', confidence: 91 },
  { text: 'ABCDE1234F', confidence: 94 }
];
ok('skips department/govt labels', extractName(panLines)?.value === 'DISHAN JADHAV', extractName(panLines)?.value);
ok('skips lines with digits', !/\d/.test(extractName(panLines)?.value ?? ''));
ok('no candidates -> null', extractName([{ text: 'DATE OF BIRTH', confidence: 90 }]) === null);

console.log('\n5. Full extraction over a realistic PAN card');
const text = `INCOME TAX DEPARTMENT
GOVT. OF INDIA
DISHAN JADHAV
RAMESH JADHAV
02/04/1999
Permanent Account Number
ABCDE1234F`;
const fields = extractFields({ text, lines: panLines });
const byKey = Object.fromEntries(fields.map((f) => [f.key, f.value]));
ok('found pan', byKey.pan === 'ABCDE1234F', byKey.pan);
ok('found dob', byKey.dob === '1999-04-02', byKey.dob);
ok('found name', byKey.fullName === 'DISHAN JADHAV', byKey.fullName);
ok('no aadhaar on a PAN card', !('aadhaarMasked' in byKey));
ok('every field carries a key+value', fields.every((f) => f.key && f.value));

console.log('\n6. Aadhaar card');
const aText = 'GOVERNMENT OF INDIA\nDISHAN JADHAV\nDOB 02/04/1999\n1234 5678 9012\nMALE';
const aFields = extractFields({
  text: aText,
  lines: [{ text: 'GOVERNMENT OF INDIA', confidence: 90 }, { text: 'DISHAN JADHAV', confidence: 89 }]
});
const aByKey = Object.fromEntries(aFields.map((f) => [f.key, f.value]));
ok('masked aadhaar only', aByKey.aadhaarMasked === 'XXXX XXXX 9012', aByKey.aadhaarMasked);
ok('full aadhaar never appears', !JSON.stringify(aFields).includes('5678'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
