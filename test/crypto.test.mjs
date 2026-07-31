import { createVault, unlockVault, encryptVault, KDF } from '../lib/crypto.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name)); };

const secret = {
  version: 1,
  fields: { fullName: 'Dishan Jadhav', dob: '1999-04-02', email: 'a@b.com',
            phone: '9876543210', address: 'Line 1\nLine 2', pan: 'ABCDE1234F',
            aadhaarMasked: 'XXXX XXXX 1234' },
  customFields: [{ id: '1', label: 'Passport', value: 'Z1234567' }],
  documents: [{ id: 'd1', type: 'photo', name: 'me.jpg', mime: 'image/jpeg',
                dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(50000), bytes: 37500 }]
};

console.log('\n1. Create + unlock round-trip');
const t0 = Date.now();
const { key, record, kdfParams } = await createVault('correct horse battery', secret);
console.log(`  (PBKDF2 ${KDF.iterations.toLocaleString()} iterations took ${Date.now() - t0} ms)`);

ok('record has no plaintext: name absent from serialised record',
   !JSON.stringify(record).includes('Dishan'));
ok('record has no plaintext: PAN absent',
   !JSON.stringify(record).includes('ABCDE1234F'));
ok('record has no plaintext: email absent',
   !JSON.stringify(record).includes('a@b.com'));
ok('record has no plaintext: document bytes absent',
   !JSON.stringify(record).includes('A'.repeat(200)));
ok('kdf params stored', record.kdf.iterations >= 150000 && record.kdf.name === 'PBKDF2');
ok('iterations meet guide floor (>=150k)', record.kdf.iterations >= 150_000);
ok('salt is 16 bytes', Buffer.from(record.kdf.salt, 'base64').length === 16);
ok('iv is 12 bytes', Buffer.from(record.iv, 'base64').length === 12);

const opened = await unlockVault('correct horse battery', record);
ok('round-trips fields', opened.data.fields.fullName === 'Dishan Jadhav');
ok('round-trips address newlines', opened.data.fields.address === 'Line 1\nLine 2');
ok('round-trips custom fields', opened.data.customFields[0].value === 'Z1234567');
ok('round-trips large document data URL',
   opened.data.documents[0].dataUrl.length === secret.documents[0].dataUrl.length);

console.log('\n2. Wrong passphrase is rejected');
let threw = null;
try { await unlockVault('wrong passphrase!!', record); } catch (e) { threw = e; }
ok('throws on wrong passphrase', threw !== null);
ok('error code is BAD_PASSPHRASE', threw?.code === 'BAD_PASSPHRASE');
ok('error message does not leak detail', !/tag|gcm|operation/i.test(threw?.message ?? ''));

console.log('\n3. Tampering is detected (GCM auth tag)');
const bytes = Buffer.from(record.ciphertext, 'base64');
bytes[10] ^= 0xff;
const tampered = { ...record, ciphertext: bytes.toString('base64') };
let threw2 = null;
try { await unlockVault('correct horse battery', tampered); } catch (e) { threw2 = e; }
ok('flipped ciphertext byte rejected', threw2 !== null);

console.log('\n4. A fresh IV on every save (the GCM rule)');
const ivs = new Set();
let r = record;
for (let i = 0; i < 25; i++) {
  r = await encryptVault(key, { ...secret, n: i }, kdfParams);
  ivs.add(r.iv);
}
ok('25 saves produced 25 distinct IVs', ivs.size === 25);
ok('salt stays constant across saves', r.kdf.salt === record.kdf.salt);
ok('same key still opens the latest record',
   (await unlockVault('correct horse battery', r)).data.fields.pan === 'ABCDE1234F');

console.log('\n5. Two vaults, same passphrase -> different salts');
const a = await createVault('same passphrase here', secret);
const b = await createVault('same passphrase here', secret);
ok('salts differ', a.record.kdf.salt !== b.record.kdf.salt);
ok('ciphertexts differ', a.record.ciphertext !== b.record.ciphertext);

console.log('\n6. Key is non-extractable');
ok('key.extractable === false', key.extractable === false);
let threw3 = null;
try { await crypto.subtle.exportKey('raw', key); } catch (e) { threw3 = e; }
ok('exportKey refuses', threw3 !== null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
