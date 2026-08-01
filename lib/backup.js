// FormPilot - encrypted backup envelope
//
// There is deliberately no new cryptography here. What sits in
// chrome.storage.local is already a self-describing encrypted envelope: KDF
// name, hash, iteration count, salt, IV and ciphertext. A backup is that
// envelope written to a file, and a restore is writing it back.
//
// Consequences worth being explicit about:
//   * The backup is exactly as strong as the passphrase that produced it.
//   * Restoring needs THAT passphrase, not whatever the device uses now.
//   * This module never sees a key or a passphrase, so there is nothing here
//     that could leak one.

export const BACKUP_MAGIC = 'formpilot-vault-backup';
export const BACKUP_VERSION = 1;

// A backup file arrives from outside: off a USB stick, out of a chat app, or
// from someone who wants you to import theirs. Everything below is checked
// before it is written to storage, because a bad record here is not merely
// invalid - it is a working attack.
//
//   * A LOW iteration count silently downgrades a restored vault. Import a file
//     claiming iterations:1 and the vault it produces has no key stretching at
//     all, while the UI still says "encrypted". The floor matches lib/crypto's
//     documented minimum.
//   * A HUGE iteration count is a denial of service: unlock derives the key
//     before it can fail, so iterations:2e9 freezes the tab for minutes.
//   * A HUGE ciphertext fills chrome.storage.local's ~10 MB quota, after which
//     the real vault can no longer be saved.
//   * Non-base64 text throws deep inside atob() at unlock time, long after the
//     point where a clear error could still be shown.
const MIN_ITERATIONS = 150_000;
const MAX_ITERATIONS = 4_000_000;
const IV_BYTES = 12;                          // AES-GCM is defined around 96 bits
const MIN_SALT_BYTES = 16;
const MIN_CIPHERTEXT_BYTES = 17;              // 16-byte GCM tag + at least one byte
const MAX_CIPHERTEXT_BYTES = 12 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Byte length of a base64 string, without decoding it. */
function base64Bytes(text) {
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

/**
 * @returns {string|null} a problem with this base64 field, or null
 */
function checkBase64(text, label, { exactly, min, max } = {}) {
  if (text.length % 4 !== 0 || !BASE64.test(text)) {
    return `The backup's ${label} is not valid base64, so the file is damaged.`;
  }
  const bytes = base64Bytes(text);
  if (exactly !== undefined && bytes !== exactly) {
    return `The backup's ${label} is ${bytes} bytes; it must be exactly ${exactly}.`;
  }
  if (min !== undefined && bytes < min) {
    return `The backup's ${label} is too short (${bytes} bytes) to be genuine.`;
  }
  if (max !== undefined && bytes > max) {
    return `The backup is too large to restore (${Math.round(bytes / 1024 / 1024)} MB of ciphertext).`;
  }
  return null;
}

/** Wrap a stored vault record in a labelled, dated envelope. */
export function wrapBackup(record) {
  return {
    magic: BACKUP_MAGIC,
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    record
  };
}

/**
 * Check a parsed file before it is allowed anywhere near real storage. Writing
 * a malformed record would leave the vault permanently unopenable, so this
 * refuses anything it cannot fully account for.
 *
 * @returns {string|null} a human-readable problem, or null if the backup is sound
 */
export function validateBackup(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'That file is not a FormPilot backup.';
  }
  if (parsed.magic !== BACKUP_MAGIC) {
    return 'That does not look like a FormPilot backup.';
  }
  if (parsed.backupVersion > BACKUP_VERSION) {
    return `That backup was written by a newer version of FormPilot (format ${parsed.backupVersion}).`;
  }

  const record = parsed.record;
  if (!record || typeof record !== 'object') return 'The backup has no vault record in it.';

  if (typeof record.ciphertext !== 'string' || !record.ciphertext) {
    return 'The backup has no ciphertext — there is nothing in it to restore.';
  }
  if (typeof record.iv !== 'string' || !record.iv) {
    return 'The backup is missing its IV, so it could never be decrypted.';
  }
  if (!record.kdf || typeof record.kdf !== 'object') {
    return 'The backup is missing its key-derivation parameters.';
  }
  if (typeof record.kdf.salt !== 'string' || !record.kdf.salt) {
    return 'The backup is missing its salt, so the key could never be re-derived.';
  }

  // --- The algorithm must be the one we actually implement ------------------
  if (record.kdf.name !== 'PBKDF2') {
    return `That backup uses ${String(record.kdf.name)} for key derivation, which FormPilot cannot open.`;
  }
  if (record.kdf.hash !== 'SHA-256') {
    return `That backup uses ${String(record.kdf.hash)} hashing, which FormPilot cannot open.`;
  }

  // --- Work factor: too low is an attack, too high is a hang ---------------
  const { iterations } = record.kdf;
  if (!Number.isInteger(iterations)) {
    return 'The backup has an invalid iteration count.';
  }
  if (iterations < MIN_ITERATIONS) {
    return `That backup claims only ${iterations.toLocaleString()} key-derivation rounds. ` +
           `FormPilot will not restore a vault below ${MIN_ITERATIONS.toLocaleString()} — ` +
           'importing it would leave your data far easier to crack than it looks.';
  }
  if (iterations > MAX_ITERATIONS) {
    return `That backup asks for ${iterations.toLocaleString()} key-derivation rounds, ` +
           'which would lock the browser up for minutes on every unlock.';
  }

  // --- Sizes and encoding ---------------------------------------------------
  return checkBase64(record.iv, 'IV', { exactly: IV_BYTES })
      ?? checkBase64(record.kdf.salt, 'salt', { min: MIN_SALT_BYTES })
      ?? checkBase64(record.ciphertext, 'ciphertext', {
        min: MIN_CIPHERTEXT_BYTES,
        max: MAX_CIPHERTEXT_BYTES
      });
}
