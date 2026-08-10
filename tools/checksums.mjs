// FormPilot - fingerprint every file that ships.
//
//   node tools/checksums.mjs            print the list
//   node tools/checksums.mjs --quiet    print only the aggregate hash
//
// WHY THIS EXISTS
//
// "No bundler, no build step, loads exactly as it sits on disk" is usually
// filed under simplicity. It is really a security property, and an unusual one:
// because nothing is compiled, minified or generated, the code a stranger can
// read in the repository is byte-for-byte the code running in their browser.
// Almost no extension can say that. A password manager with a build pipeline
// cannot - you have to trust that their source produced their bundle.
//
// A property nobody can check is worth nothing, so this makes it checkable.
// Run it here, run it against an unpacked copy of what the browser actually
// installed, and compare. Any difference at all is a difference that matters.
//
// See README.md, "Verify what you installed".

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, shippedFiles, manifest as readManifest } from './shipped.mjs';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const files = shippedFiles();
const lines = files.map((rel) => `${sha256(fs.readFileSync(path.join(ROOT, rel)))}  ${rel}`);

// One hash over the whole list, so a release can be quoted as a single string.
// It covers filenames as well as contents, so an added or renamed file changes
// it even when every individual file is untouched.
const aggregate = sha256(Buffer.from(lines.join('\n'), 'utf8'));

const quiet = process.argv.includes('--quiet');
if (!quiet) {
  console.log(`FormPilot ${readManifest().version} — ${files.length} shipped files\n`);
  console.log(lines.join('\n'));
  console.log('');
}
console.log(`${aggregate}  (aggregate)`);
