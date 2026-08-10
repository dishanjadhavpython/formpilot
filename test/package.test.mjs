// FormPilot - is the thing we are about to upload actually correct?
//
//   node test/package.test.mjs
//
// Store review is slow and a rejection costs days, but the worse failure is the
// one that passes review: a package missing a stylesheet or a lib file installs
// fine, loads, and is broken for every user until the next release clears the
// queue. Nothing else in the suite looks at the package, because until Phase 9
// there wasn't one.
//
// Three questions, in order of how much they would cost to get wrong:
//   1. Is every file the extension references actually in the package?
//   2. Is anything in there that should not be? (the test suite, the docs, .git)
//   3. Is the archive well-formed and reproducible, so a published hash means
//      something?

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, shippedFiles, manifest as readManifest } from '../tools/shipped.mjs';
import { buildPackage } from '../tools/package.mjs';

let pass = 0, fail = 0;
const ok = (name, condition, detail = '') => {
  condition ? pass++ : fail++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const files = shippedFiles();
const shipped = new Set(files);
const manifest = readManifest();

// ============================================================================
console.log('\n1. Everything the extension references is in the package');
// ============================================================================

{
  // Paths the manifest names directly. A missing one of these is a load error.
  const wanted = new Set([
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...Object.values(manifest.action?.default_icon ?? {}),
    ...Object.values(manifest.icons ?? {})
  ].filter(Boolean));

  const missing = [...wanted].filter((file) => !shipped.has(file));
  ok('every manifest-referenced file ships', missing.length === 0, missing.join(', '));
}

{
  // Everything the HTML pages pull in: scripts, stylesheets, images. These fail
  // silently - an absent stylesheet is an ugly page, not an error dialog - which
  // is exactly why they are worth checking mechanically.
  const pages = files.filter((file) => file.endsWith('.html'));
  ok('the package contains HTML pages', pages.length > 0, pages.join(', '));

  const missing = [];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const refs = [
      ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
      ...html.matchAll(/<link[^>]+href="([^"]+)"/g),
      ...html.matchAll(/<img[^>]+src="([^"]+)"/g)
    ].map((match) => match[1]);

    for (const ref of refs) {
      if (/^(https?:|data:|chrome-extension:|#)/.test(ref)) continue;
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(page), ref));
      if (!shipped.has(resolved)) missing.push(`${page} -> ${ref}`);
    }
  }
  ok('every script/style/image a page references ships', missing.length === 0, missing.join(', '));
}

{
  // content.js and lib/match.js are never named in the manifest - they are
  // injected by path at runtime, so a typo or an omission here is invisible
  // until somebody clicks Fill on a real page.
  const injected = new Set();
  for (const file of ['background.js', 'popup.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of source.matchAll(/files:\s*\[([^\]]+)\]/g)) {
      for (const quoted of match[1].matchAll(/['"]([^'"]+)['"]/g)) injected.add(quoted[1]);
    }
  }
  ok('injected script paths were found', injected.size > 0, [...injected].join(', '));
  const missing = [...injected].filter((file) => !shipped.has(file));
  ok('every programmatically injected file ships', missing.length === 0, missing.join(', '));
}

{
  // The OCR engine resolves its assets at runtime, out of one vendored folder.
  // Losing one does not throw until somebody actually runs OCR, and the failure
  // mode is worse than a crash: per CLAUDE.md rule 5, tesseract silently falls
  // back to fetching that asset from a CDN.
  //
  // The paths are template literals over a base directory rather than literal
  // getURL() arguments, so read the base and the suffixes separately.
  const ocr = fs.readFileSync(path.join(ROOT, 'lib/ocr.js'), 'utf8');
  const vendor = /VENDOR\s*=\s*['"]([^'"]+)['"]/.exec(ocr)?.[1];
  ok('the OCR vendor folder is named in lib/ocr.js', Boolean(vendor), String(vendor));

  const suffixes = [...ocr.matchAll(/(?:workerPath|corePath):\s*`\$\{base\}\/([^`]+)`/g)]
    .map((match) => match[1]);
  ok('workerPath and corePath were found', suffixes.length === 2, suffixes.join(', '));

  // langPath is the folder itself; the worker appends this filename to it.
  const needed = [...suffixes, 'eng.traineddata.gz'].map((file) => `${vendor}/${file}`);
  const missing = needed.filter((file) => !shipped.has(file));
  ok('every OCR asset ships', missing.length === 0,
    missing.length ? `${missing.join(', ')} — a missing one silently restores a CDN fetch`
                   : needed.map((file) => path.basename(file)).join(', '));

  ok('langPath points at a folder that ships',
    /langPath:\s*base/.test(ocr) && files.some((file) => file.startsWith(`${vendor}/`)));
}

// ============================================================================
console.log('\n2. Nothing ships that should not');
// ============================================================================

{
  const leaked = files.filter((file) =>
    /^(test|tools|store|dist|\.git|\.github|\.idea|node_modules)\//.test(file)
    || /^(CLAUDE|PLAN|OVERVIEW|DESIGN|README|SECURITY|PRIVACY|run)\.md$/.test(file)
    || file.endsWith('.pdf')
    || file === 'package.json');
  ok('no development files in the package', leaked.length === 0, leaked.join(', '));
}

ok('no .DS_Store or editor droppings',
  !files.some((file) => /(^|\/)(\.DS_Store|\.swp|~)$/.test(file)),
  files.filter((file) => /(^|\/)(\.DS_Store|\.swp|~)$/.test(file)).join(', '));

ok('the licence travels with the code', shipped.has('LICENSE'),
  'MIT requires the notice in all copies, and a shipped extension is a copy');

ok('vendor licences travel with vendor code',
  files.some((file) => /^vendor\/.*LICENSE/i.test(file)),
  files.filter((file) => /^vendor\//.test(file)).length + ' vendor files');

// ============================================================================
console.log('\n3. The archive is well-formed and reproducible');
// ============================================================================

const first = buildPackage();
const second = buildPackage();

ok('the package is not empty', first.zip.length > 0, `${(first.zip.length / 1024 / 1024).toFixed(2)} MB`);
ok('it starts with a local file header',
  first.zip.readUInt32LE(0) === 0x04034b50, `0x${first.zip.readUInt32LE(0).toString(16)}`);

{
  // The end-of-central-directory record is the last 22 bytes when there is no
  // archive comment, and its entry count must match what we put in.
  const eocd = first.zip.length - 22;
  ok('it ends with an end-of-central-directory record',
    first.zip.readUInt32LE(eocd) === 0x06054b50);
  ok('the directory lists every file',
    first.zip.readUInt16LE(eocd + 10) === first.files.length,
    `${first.zip.readUInt16LE(eocd + 10)} listed, ${first.files.length} expected`);
}

ok('two builds produce identical bytes',
  Buffer.compare(first.zip, second.zip) === 0,
  'a published hash is worthless if the build is not reproducible');

{
  // Chrome rejects a package over 2 GB outright, but the number that actually
  // matters is the one a user waits for on a slow connection.
  const mb = first.zip.length / 1024 / 1024;
  ok('the package is a sane size', mb > 0.5 && mb < 50, `${mb.toFixed(2)} MB`);
}

ok('the version is not a placeholder',
  /^\d+\.\d+\.\d+$/.test(manifest.version) && manifest.version !== '0.0.0',
  manifest.version);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
