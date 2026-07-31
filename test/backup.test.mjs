import { createVault, unlockVault } from '../lib/crypto.js';
import { wrapBackup, validateBackup, BACKUP_MAGIC } from '../lib/backup.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };

const secret = {
  version: 1,
  fields: { fullName: 'Dishan Jadhav', pan: 'ABCDE1234F', aadhaarMasked: 'XXXX XXXX 9012' },
  customFields: [{ id: '1', label: 'Passport', value: 'Z1234567' }],
  documents: [{ id: 'd', type: 'photo', name: 'p.jpg', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(20000), bytes: 15000 }]
};

console.log('\n1. Export -> file -> import survives a full round trip');
const { record } = await createVault('a passphrase that is long', secret);
const wire = JSON.stringify(wrapBackup(record));      // exactly what hits disk
const restored = JSON.parse(wire);

ok('validates clean', validateBackup(restored) === null, validateBackup(restored) ?? 'ok');
const opened = await unlockVault('a passphrase that is long', restored.record);
ok('decrypts after round trip', opened.data.fields.fullName === 'Dishan Jadhav');
ok('documents survive', opened.data.documents[0].dataUrl.length === secret.documents[0].dataUrl.length);
ok('custom fields survive', opened.data.customFields[0].value === 'Z1234567');

console.log('\n2. The backup file itself leaks nothing');
ok('no name in the file', !wire.includes('Dishan'));
ok('no PAN in the file', !wire.includes('ABCDE1234F'));
ok('no document bytes', !wire.includes('A'.repeat(200)));
ok('is labelled as a backup', restored.magic === BACKUP_MAGIC);

console.log('\n3. Wrong passphrase still fails on a restored backup');
let threw = null;
try { await unlockVault('the wrong passphrase', restored.record); } catch (e) { threw = e; }
ok('rejects wrong passphrase', threw?.code === 'BAD_PASSPHRASE');

console.log('\n4. Malformed files are refused before touching storage');
const bad = (label, value) => ok(label, typeof validateBackup(value) === 'string', String(validateBackup(value)).slice(0, 56));
bad('null', null);
bad('a string', 'hello');
bad('an array', [1, 2, 3]);
bad('arbitrary JSON', { hello: 'world' });
bad('wrong magic', { ...restored, magic: 'something-else' });
bad('no record', { magic: BACKUP_MAGIC, backupVersion: 1 });
bad('no ciphertext', { magic: BACKUP_MAGIC, record: { iv: 'x', kdf: { salt: 's', iterations: 1000 } } });
bad('no iv', { magic: BACKUP_MAGIC, record: { ciphertext: 'c', kdf: { salt: 's', iterations: 1000 } } });
bad('no salt', { magic: BACKUP_MAGIC, record: { ciphertext: 'c', iv: 'x', kdf: { iterations: 1000 } } });
bad('no kdf at all', { magic: BACKUP_MAGIC, record: { ciphertext: 'c', iv: 'x' } });
bad('iterations = 0', { magic: BACKUP_MAGIC, record: { ciphertext: 'c', iv: 'x', kdf: { salt: 's', iterations: 0 } } });
bad('iterations NaN', { magic: BACKUP_MAGIC, record: { ciphertext: 'c', iv: 'x', kdf: { salt: 's', iterations: 'many' } } });
bad('future format', { ...restored, backupVersion: 99 });

console.log('\n5. A truncated backup is caught by GCM, not silently accepted');
const truncated = JSON.parse(wire);
truncated.record.ciphertext = truncated.record.ciphertext.slice(0, -40);
ok('passes shape validation', validateBackup(truncated) === null);
let threw2 = null;
try { await unlockVault('a passphrase that is long', truncated.record); } catch (e) { threw2 = e; }
ok('but fails to decrypt', threw2 !== null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
