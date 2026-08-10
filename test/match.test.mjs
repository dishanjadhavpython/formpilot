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

console.log('\n7. Multiple emails');
const emails = [
  { id: '1', label: 'work',      value: 'me@company.com' },
  { id: '2', label: 'college',   value: 'me@uni.edu' },
  { id: '3', label: 'alternate', value: 'alt@mail.com' }
];
const dictE = M.buildDictionary([], emails);
const inferE = (t) => M.inferKey(M.normalise(t), dictE)?.key ?? null;

expect('Email',                inferE('Email'),                'email');
expect('Email Address',        inferE('Email Address'),        'email');
// The whole point of `priority`: "email address" is the LONGER phrase, so
// without it these would all fall back to the primary address.
expect('Work Email Address',   inferE('Work Email Address'),   'email:work');
expect('Official Email',       inferE('Official Email'),       'email:work');
expect('College Email ID',     inferE('College Email ID'),     'email:college');
expect('Alternate Email',      inferE('Alternate Email'),      'email:alternate');
expect('Secondary Email Address', inferE('Secondary Email Address'), 'email:alternate');
// Somebody else's field, and no guardian address configured -> fill nothing.
expect('Parent Email (none set)', inferE('Parent Email'),      null);

// With one configured, the labelled value fills it.
const dictG = M.buildDictionary([], [{ id: 'g', label: 'guardian', value: 'dad@mail.com' }]);
const inferG = (t) => M.inferKey(M.normalise(t), dictG)?.key ?? null;
expect('Parent Email (set)',   inferG('Parent Email'),         'email:guardian');
expect("Father's Email",       inferG("Father's Email"),       'email:guardian');

const vals = M.expandValues({ email: 'main@me.com', fullName: 'A B' }, [], emails);
expect('primary kept',      vals.email,                'main@me.com');
expect('work value',        vals['email:work'],        'me@company.com');
expect('college value',     vals['email:college'],     'me@uni.edu');
expect('explicit alternate wins over fallback', vals['email:alternate'], 'alt@mail.com');

// With no alternate labelled, the first extra answers an "alternate" field.
const vals2 = M.expandValues({ email: 'main@me.com' }, [], [emails[0]]);
expect('alternate falls back to first extra', vals2['email:alternate'], 'me@company.com');

// No primary set: the first extra becomes the answer for a plain Email field.
const vals3 = M.expandValues({}, [], [emails[0]]);
expect('primary falls back to first extra', vals3.email, 'me@company.com');

// Unlabelled or empty rows must not create phantom keys.
const vals4 = M.expandValues({}, [], [{ id: 'x', label: 'work', value: '' }]);
expect('blank email ignored', vals4['email:work'], undefined);

console.log("\n8. Somebody else's fields never take your own details");
// "Father's Name" matches the fullName synonym "name" - it must not fill.
expect("Father's Name",        infer("Father's Name"),         null);
expect("Mother's Name",        infer("Mother's Name"),         null);
expect('Spouse Name',          infer('Spouse Name'),           null);
expect('Nominee Name',         infer('Nominee Name'),          null);
expect('Emergency Contact No', infer('Emergency Contact No'),  null);
expect('Guardian Address',     infer('Guardian Address'),      null);
// ...but the user's own equivalents still fill.
expect('still fills own name', infer('Full Name'),             'fullName');
expect('still fills own addr', infer('Permanent Address'),     'address');

console.log('\n9. A taught custom field still outranks a generic guess');
const dictC = M.buildDictionary([{ label: 'Email', value: 'x@y.z' }], []);
expect('custom "Email" beats builtin', M.inferKey(M.normalise('Email'), dictC)?.key, 'custom:Email');

console.log('\n10. Document (file-upload) label matching');
const docDict = M.buildDocDictionary();
const inferDoc = (text) => M.inferKey(M.normalise(text), docDict)?.key ?? null;

expect('Upload Aadhar Card Image', inferDoc('Upload Aadhar Card Image'), 'aadhaar');
expect('Upload PAN Card Image',    inferDoc('Upload PAN Card Image'),    'pan');
expect('Upload Signature',         inferDoc('Upload Signature'),         'signature');
expect('Passport size photo',      inferDoc('Passport size photo'),      'photo');
expect('Proof of Identity',        inferDoc('Proof of Identity'),        'idProof');
expect('Aadhar Card',              inferDoc('Aadhar Card'),              'aadhaar');

console.log('\n   ...and refuses labels with no real synonym');
expect('Upload File',              inferDoc('Upload File'),              null);
expect('Attachment',               inferDoc('Attachment'),               null);
expect('Supporting Document',      inferDoc('Supporting Document'),      null);

console.log('\n11. acceptsMime');
expect('no accept attr allows anything',      M.acceptsMime('', 'image/jpeg'),                true);
expect('image/* allows jpeg',                 M.acceptsMime('image/*', 'image/jpeg'),          true);
expect('exact mime match',                    M.acceptsMime('image/png', 'image/png'),         true);
expect('.jpg token matches image/jpeg',       M.acceptsMime('.jpg,.png', 'image/jpeg'),        true);
expect('.jpeg token matches image/jpeg too',  M.acceptsMime('.jpeg', 'image/jpeg'),             true);
expect('.pdf-only rejects an image',          M.acceptsMime('.pdf,application/pdf', 'image/jpeg'), false);
expect('mismatched mime is rejected',         M.acceptsMime('image/png', 'image/jpeg'),        false);

console.log('\n12. describeDocs / pickDocs');
const documents = [
  { type: 'aadhaar',   name: 'aadhaar.jpg',   mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AAAA' },
  { type: 'pan',       name: 'pan.jpg',       mime: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BBBB' },
  { type: 'signature', name: 'sig.png',       mime: 'image/png',  dataUrl: 'data:image/png;base64,CCCC' }
];
const docMeta = M.describeDocs(documents);
expect('docKeys lists every type', JSON.stringify(docMeta.docKeys.sort()), JSON.stringify(['aadhaar', 'pan', 'signature']));
expect('docMimes carries the mime', docMeta.docMimes.aadhaar, 'image/jpeg');
expect('describeDocs never carries a dataUrl', JSON.stringify(docMeta).includes('data:'), false);

const picked = M.pickDocs(documents, ['pan']);
expect('pickDocs returns only the asked-for type', JSON.stringify(Object.keys(picked)), '["pan"]');
expect('pickDocs keeps the dataUrl for a released type', picked.pan.dataUrl, 'data:image/jpeg;base64,BBBB');
expect('an empty request yields nothing', Object.keys(M.pickDocs(documents, [])).length, 0);

console.log('\n13. Choice fields infer the right key');
expect('Gender',              infer('Gender'),              'gender');
expect('Sex',                 infer('Sex'),                 'gender');
expect('Category',            infer('Category'),            'category');
expect('Social Category',     infer('Social Category'),     'category');
expect('Reservation Category', infer('Reservation Category'), 'category');
expect('Marital Status',      infer('Marital Status'),      'maritalStatus');
expect('choice keys are marked choice-only', M.CHOICE_ONLY.has('category'), true);
expect('ordinary keys are not',              M.CHOICE_ONLY.has('email'),    false);

console.log('\n14. chooseOption picks the right option');
const gender = [
  { value: 'M', text: 'Male' },
  { value: 'F', text: 'Female' },
  { value: 'T', text: 'Transgender' }
];
// The one that matters. 'female'.includes('male') is true, so a substring pass
// silently ticks Female for a user who stored Male.
expect('Male does not match Female',   M.chooseOption('Male', gender),   0);
expect('Female matches Female',        M.chooseOption('Female', gender), 1);
expect('matching is case-insensitive', M.chooseOption('male', gender),   0);
expect('the option value works too',   M.chooseOption('T', gender),      2);
expect('an unknown value picks nothing', M.chooseOption('Unspecified', gender), -1);
expect('an empty value picks nothing',   M.chooseOption('', gender),      -1);

const category = [
  { value: 'gen', text: 'General / Unreserved' },
  { value: 'obc', text: 'OBC' },
  { value: 'sc',  text: 'SC' },
  { value: 'st',  text: 'ST' }
];
expect('General finds "General / Unreserved"', M.chooseOption('General', category), 0);
expect('OBC matches exactly',                  M.chooseOption('OBC', category),     1);
// "SC" is two characters, so the loose pass never runs on it - otherwise it
// would hit "SC" and "ST" and "General / Unreserved" is not far behind.
expect('SC matches exactly, not loosely',      M.chooseOption('SC', category),      2);
expect('ST matches exactly, not loosely',      M.chooseOption('ST', category),      3);

const marital = [{ value: 's', text: 'Single' }, { value: 'm', text: 'Married' }];
expect('Married is not matched by Marr',  M.chooseOption('Marr', marital),   -1);
expect('Single matches',                  M.chooseOption('Single', marital),  0);
expect('no options at all is safe',       M.chooseOption('Single', []),      -1);
expect('a missing options list is safe',  M.chooseOption('Single'),          -1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
