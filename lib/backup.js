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
  if (!Number.isFinite(record.kdf.iterations) || record.kdf.iterations < 1) {
    return 'The backup has an invalid iteration count.';
  }
  return null;
}
