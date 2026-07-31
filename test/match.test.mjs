import fs from 'node:fs';
import vm from 'node:vm';
vm.runInThisContext(fs.readFileSync(new URL('../lib/match.js', import.meta.url), 'utf8'));
const M = globalThis.FormPilotMatch;

let pass = 0, fail = 0;
const dict = M.buildDictionary([{ label: 'Passport no.', value: 'Z1234567' }]);

function expect(label, got, want) {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} -> ${got ?? 'null'}${ok ? '' : `   (wanted ${want ?? 'null'})`}`);
}
const infer = (text) => M.inferKey(M.normalise(text), dict)?.key ?? null;

console.log('\n1. Specific beats generic');
expect('First Name',        infer('First Name'),        'firstName');
expect('firstName (camel)', infer('firstName'),         'firstName');
expect('first_name',        infer('first_name'),        'firstName');
expect('Full Name',         infer('Full Name'),         'fullName');
expect('Name',              infer('Name'),              'fullName');
expect('Surname',           infer('Surname'),           'lastName');
expect('Middle Name',       infer('Middle Name'),       'middleName');

console.log('\n2. Real-world labels');
expect('Email Address',     infer('Email Address'),     'email');
expect('E-mail',            infer('E-mail'),            'email');
expect('Mobile Number',     infer('Mobile Number'),     'phone');
expect('Contact No.',       infer('Contact No.'),       'phone');
expect('Date of Birth',     infer('Date of Birth'),     'dob');
expect('DOB',               infer('DOB'),               'dob');
expect('D.O.B.',            infer('D.O.B.'),            'dob');
expect('PAN Card Number',   infer('PAN Card Number'),   'pan');
expect('Aadhaar Number',    infer('Aadhaar Number'),    'aadhaarMasked');
expect('Permanent Address', infer('Permanent Address'), 'address');
expect('PIN Code',          infer('PIN Code'),          'postcode');
expect('Passport no.',      infer('Passport no.'),      'custom:Passport no.');

console.log('\n3. Refuses dangerous / wrong fields');
expect('username',          infer('username'),          null);
expect('User Name',         infer('User Name'),         null);
expect('Company Name',      infer('Company Name'),      null);
expect('Organisation Name', infer('Organisation Name'), null);
expect('Confirm Password',  infer('Confirm Password'),  null);
expect('OTP',               infer('OTP'),               null);
expect('Enter Captcha',     infer('Enter Captcha'),     null);
expect('Search',            infer('Search'),            null);
expect('Coupon Code',       infer('Coupon Code'),       null);

console.log('\n4. Word boundaries (no substring bleed)');
expect('Panel Member',      infer('Panel Member'),      null);
expect('Company',           infer('Company'),           null);
expect('Nickname',          infer('Nickname'),          null);
expect('Telegram',          infer('Telegram'),          null);

console.log('\n5. autocomplete tokens');
const ac = (v) => M.AUTOCOMPLETE_MAP[v.split(/\s+/).pop()] ?? null;
expect('given-name',            ac('given-name'),             'firstName');
expect('billing street-address',ac('billing street-address'), 'address');
expect('bday',                  ac('bday'),                   'dob');

console.log('\n6. expandValues derives names');
const v = M.expandValues(
  { fullName: 'Dishan Kumar Jadhav', email: 'a@b.com', dob: '1999-04-02' },
  [{ label: 'Passport no.', value: 'Z1234567' }]
);
expect('firstName',   v.firstName,               'Dishan');
expect('middleName',  v.middleName,              'Kumar');
expect('lastName',    v.lastName,                'Jadhav');
expect('custom key',  v['custom:Passport no.'],  'Z1234567');
const single = M.expandValues({ fullName: 'Prince' }, []);
expect('single-word name', single.firstName, 'Prince');
expect('no bogus lastName', single.lastName, undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
