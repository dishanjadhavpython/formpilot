// FormPilot - build the ZIP that gets uploaded to a store.
//
//   node tools/package.mjs        writes dist/formpilot-<version>.zip
//
// WHY THIS IS HAND-ROLLED
//
// Two rules meet here. The project has no npm dependencies, so no archiver
// library. And a release should be verifiable, which means the ZIP has to be
// REPRODUCIBLE: build it twice from the same source and get the same bytes.
// Shelling out to `zip` gives neither guarantee - it stamps the local mtime
// into every entry, so two builds of identical code differ, and the published
// hash proves nothing.
//
// So: a minimal ZIP writer, deflate + store, with every timestamp pinned to the
// ZIP epoch. The output is a pure function of the file contents and names,
// which is what makes `npm run checksums` on an installed copy worth running.
//
// Chrome and Edge both accept a plain ZIP of the extension directory; neither
// needs a signed CRX for a store upload.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, shippedFiles, manifest } from './shipped.mjs';

// --- CRC-32 -----------------------------------------------------------------
//
// zlib.crc32 exists only from Node 22, and CI runs 20. Fifteen lines is a
// cheaper fix than a version floor.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0 ^ -1;
  for (let i = 0; i < buffer.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

// --- ZIP --------------------------------------------------------------------

// 1980-01-01 00:00:00, the earliest a ZIP can represent. Pinning it is what
// makes the build reproducible - a real mtime would change every checkout.
const DOS_TIME = 0;
const DOS_DATE = 33;   // (1980-1980) << 9 | 1 << 5 | 1

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @returns {Buffer} a complete ZIP archive
 */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });

    // Only compress when it actually helps. Already-compressed payloads (PNG
    // icons, the gzipped traineddata) grow under deflate.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0, 6);             // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);            // extra field length

    chunks.push(local, nameBytes, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(20, 4);              // version made by
    dir.writeUInt16LE(20, 6);              // version needed
    dir.writeUInt16LE(0, 8);               // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30);              // extra
    dir.writeUInt16LE(0, 32);              // comment
    dir.writeUInt16LE(0, 34);              // disk number
    dir.writeUInt16LE(0, 36);              // internal attributes
    dir.writeUInt32LE(0, 38);              // external attributes
    dir.writeUInt32LE(offset, 42);         // local header offset

    central.push(Buffer.concat([dir, nameBytes]));
    offset += local.length + nameBytes.length + body.length;
  }

  const directory = Buffer.concat(central);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);                        // this disk
  eocd.writeUInt16LE(0, 6);                        // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);                       // comment length

  return Buffer.concat([...chunks, directory, eocd]);
}

// --- Build ------------------------------------------------------------------

export function buildPackage() {
  const files = shippedFiles();
  const entries = files.map((name) => ({ name, data: fs.readFileSync(path.join(ROOT, name)) }));
  return { files, zip: buildZip(entries) };
}

// Run directly, not when imported by the test suite. pathToFileURL rather than
// string concatenation: import.meta.url percent-encodes, so any path with a
// space in it (this project lives in one) would never match.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = manifest().version;
  const { files, zip } = buildPackage();

  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, `formpilot-${version}.zip`);
  fs.writeFileSync(out, zip);

  const raw = files.reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0);
  const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

  console.log(`\nFormPilot ${version}`);
  console.log(`  ${files.length} files, ${mb(raw)} on disk -> ${mb(zip.length)} zipped`);
  console.log(`  ${path.relative(ROOT, out)}`);
  console.log(`  sha256 ${crypto.createHash('sha256').update(zip).digest('hex')}`);
  console.log('\nUpload this file. Publish the hash above beside the release.\n');
}
