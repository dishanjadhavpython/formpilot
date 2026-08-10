// FormPilot - the single answer to "which files does the browser actually get?"
//
// Both the release checksums and the store package are built from this list. A
// second copy of it would drift, and the two failure modes are opposite and
// both bad: a checksum list that covers a file the package omits, or a package
// carrying a file nobody fingerprinted.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything NOT named here ships, which is the safe way round: a new file
// added to the extension is picked up automatically, whereas an allowlist would
// silently leave it out of the package and only fail once a user installed it.
export const NOT_SHIPPED = new Set([
  // Development
  '.git', '.github', '.idea', '.vscode', 'node_modules', 'test', 'tools',
  'store', 'dist', '.gitignore', '.DS_Store',
  'package.json', 'package-lock.json',
  // Documentation. Everything here is worth reading and none of it is worth
  // shipping: the store package should be code, not a repository.
  'CLAUDE.md', 'PLAN.md', 'OVERVIEW.md', 'DESIGN.md', 'README.md',
  'SECURITY.md', 'PRIVACY.md', 'run.md',
  'FormPilot_Build_Guide.pdf'
]);

// Two deliberate inclusions, both licence obligations rather than preferences:
//   LICENSE      - MIT requires the notice to travel with "all copies or
//                  substantial portions of the Software". A shipped extension
//                  is a copy, so leaving it out would breach our own terms.
//   vendor/*     - its licences and provenance notes must accompany the code
//                  they describe, for the same reason.

/** Every shipped file, relative to ROOT, sorted for reproducibility. */
export function shippedFiles(dir = ROOT, base = '') {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (NOT_SHIPPED.has(rel) || NOT_SHIPPED.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...shippedFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

export function manifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
}
