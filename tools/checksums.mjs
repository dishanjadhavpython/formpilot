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
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything NOT in this list ships, which is the safe way round: a new file
// added to the extension is fingerprinted automatically, whereas an allowlist
// would silently leave it unverified. These are the things Chrome never sees.
const NOT_SHIPPED = new Set([
  '.git', '.github', '.idea', 'node_modules', 'test', 'tools', 'dist',
  '.gitignore', 'package.json', 'package-lock.json',
  'CLAUDE.md', 'PLAN.md', 'OVERVIEW.md', 'DESIGN.md', 'README.md',
  'SECURITY.md', 'PRIVACY.md', 'run.md', 'FormPilot_Build_Guide.pdf'
]);

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (NOT_SHIPPED.has(rel) || NOT_SHIPPED.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const files = walk(ROOT).sort();
const lines = files.map((rel) => `${sha256(fs.readFileSync(path.join(ROOT, rel)))}  ${rel}`);

// One hash over the whole list, so a release can be quoted as a single string.
// It covers filenames as well as contents, so an added or renamed file changes
// it even when every individual file is untouched.
const aggregate = sha256(Buffer.from(lines.join('\n'), 'utf8'));

const quiet = process.argv.includes('--quiet');
if (!quiet) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  console.log(`FormPilot ${manifest.version} — ${files.length} shipped files\n`);
  console.log(lines.join('\n'));
  console.log('');
}
console.log(`${aggregate}  (aggregate)`);
