// FormPilot - vault crypto (Web Crypto API, no libraries)
//
// ============================================================================
// THE WHOLE SCHEME IN PLAIN ENGLISH
// ============================================================================
//
// A passphrase is not a key. It is short, human, and low-entropy. So we do two
// separate jobs:
//
//   1. KEY DERIVATION (PBKDF2)
//      Turn the passphrase into a real 256-bit key by hashing it hundreds of
//      thousands of times together with a random "salt". The repetition is the
//      point: it makes each guess expensive, so brute-forcing the passphrase
//      offline becomes slow. The salt is random per vault and stored in the
//      clear - its job is to stop attackers from precomputing one giant table
//      that cracks everybody's vault at once. A salt is not a secret.
//
//   2. ENCRYPTION (AES-256-GCM)
//      Encrypt the vault JSON with that derived key. GCM is "authenticated"
//      encryption: it produces ciphertext AND a built-in tamper tag. Decryption
//      fails loudly if even one byte was altered - which is also how we check
//      the passphrase (see verifying-the-passphrase below).
//
// The derived key never touches disk. It exists only as a non-extractable
// CryptoKey object in the memory of the page that unlocked the vault, and it
// disappears on lock or when the page closes.
//
// ============================================================================
// THE ONE RULE YOU MUST NOT BREAK: NEVER REUSE AN IV
// ============================================================================
//
// AES-GCM needs a 12-byte IV ("initialisation vector", a.k.a. nonce) per
// encryption. Encrypting two different messages with the SAME key and the SAME
// IV leaks the plaintext XOR and destroys the authentication guarantee. It is
// the classic way people break GCM.
//
// So: a fresh random IV on EVERY save. Never cached, never incremented, never
// copied from the previous record. Like the salt, the IV is not secret and is
// stored alongside the ciphertext.
//
// ============================================================================
// VERIFYING THE PASSPHRASE
// ============================================================================
//
// We deliberately do NOT store a password hash to check against - that would be
// one more thing to attack. Instead we derive the key from whatever passphrase
// was typed and try to decrypt. If the passphrase was wrong, the derived key is
// wrong, GCM's tamper tag does not validate, and crypto.subtle.decrypt throws.
// A thrown error IS the "wrong passphrase" signal. There is no way to tell a
// wrong passphrase from corrupted data, and that is fine.
//
// ============================================================================
// WHAT IS *NOT* ENCRYPTED (be honest about the edges)
// ============================================================================
//
// The stored record keeps the format version, KDF parameters, salt, IV and an
// updatedAt timestamp in the clear. That is standard and necessary - you need
// them to derive the key before you can decrypt anything. The leak is limited
// to "a vault exists and was last written at time T". Everything with actual
// personal data in it is inside the ciphertext.

// --- Tunables ---------------------------------------------------------------

export const KDF = {
  name: 'PBKDF2',
  hash: 'SHA-256',
  // OWASP's current floor for PBKDF2-SHA256 is 600k; the build guide asks for
  // >=150k. 310k is the widely deployed middle ground (it is what 1Password and
  // Bitwarden shipped) and costs roughly a quarter-second in-browser. The value
  // is stored per vault, so raising it later will not lock anyone out of an
  // existing vault.
  iterations: 310_000,
  saltBytes: 16
};

export const IV_BYTES = 12;      // 96 bits - the size AES-GCM is designed around
export const VAULT_FORMAT = 1;   // bump when the record shape changes

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- Small helpers ----------------------------------------------------------

export function randomBytes(length) {
  // crypto.getRandomValues is a CSPRNG. Math.random() is not - never use it here.
  return crypto.getRandomValues(new Uint8Array(length));
}

// chrome.storage.local stores JSON, so raw bytes have to become base64 text.
// Done in chunks because String.fromCharCode(...bytes) overflows the call stack
// on anything large (document images make these arrays megabytes long).
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Step 1: passphrase -> key ---------------------------------------------

/**
 * Derive an AES-256-GCM key from a passphrase using PBKDF2.
 *
 * @param {string} passphrase  what the user typed
 * @param {Uint8Array} salt    random per vault, stored in the clear
 * @param {number} iterations  stored per vault so old vaults keep working
 * @returns {Promise<CryptoKey>} non-extractable AES-GCM key
 */
export async function deriveKey(passphrase, salt, iterations = KDF.iterations) {
  // 1a. Wrap the raw passphrase bytes in a CryptoKey that is ONLY allowed to be
  //     used as PBKDF2 input. extractable:false means JS can never read the
  //     passphrase back out of this object.
  const baseKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,          // extractable
    ['deriveKey']   // this key may ONLY derive other keys
  );

  // 1b. Stretch it. This is the expensive part - deliberately so.
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF.hash },
    baseKey,
    { name: 'AES-GCM', length: 256 },  // the key we actually want
    false,                             // extractable:false -> cannot be exported,
                                       //   so it cannot be accidentally logged
                                       //   or written to storage
    ['encrypt', 'decrypt']
  );
}

// --- Step 2: encrypt / decrypt ---------------------------------------------

/**
 * Encrypt a JS object into a storable record. Generates a FRESH random IV.
 *
 * @param {CryptoKey} key
 * @param {object} data                the whole vault object
 * @param {{salt: string, iterations: number}} kdfParams  reused from setup
 * @returns {Promise<object>} the record to hand to chrome.storage.local
 */
export async function encryptVault(key, data, kdfParams) {
  // 2a. A NEW random IV for this specific save. See the warning at the top.
  const iv = randomBytes(IV_BYTES);

  // 2b. Serialise, then encrypt. AES-GCM appends its authentication tag to the
  //     ciphertext automatically, so `ciphertext` here is ct||tag.
  const plaintext = encoder.encode(JSON.stringify(data));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  return {
    format: VAULT_FORMAT,
    kdf: {
      name: KDF.name,
      hash: KDF.hash,
      iterations: kdfParams.iterations,
      salt: kdfParams.salt          // base64, same salt for the life of the vault
    },
    iv: bytesToBase64(iv),          // base64, different on every single save
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Decrypt a record with an already-derived key.
 * Throws if the key is wrong or the ciphertext was tampered with.
 */
export async function decryptVault(key, record) {
  const iv = base64ToBytes(record.iv);
  const ciphertext = base64ToBytes(record.ciphertext);

  // If this throws, either the passphrase was wrong or a byte changed. GCM
  // refuses to hand back plaintext it cannot authenticate.
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

  return JSON.parse(decoder.decode(plaintext));
}

// --- The two operations the UI actually calls -------------------------------

/**
 * First run: create a brand-new vault from a passphrase.
 * Generates the random salt that this vault keeps forever.
 */
export async function createVault(passphrase, initialData) {
  const salt = randomBytes(KDF.saltBytes);
  const kdfParams = { salt: bytesToBase64(salt), iterations: KDF.iterations };

  const key = await deriveKey(passphrase, salt, KDF.iterations);
  const record = await encryptVault(key, initialData, kdfParams);

  // Hand the key back so the caller can stay unlocked without re-deriving.
  return { key, record, kdfParams };
}

/**
 * Change the passphrase on an existing vault.
 *
 * Until this existed, a passphrase you suspected was compromised was a
 * passphrase you were stuck with: the only remedy was to export, wipe, and set
 * up again from scratch. Every backup also stayed tied to whatever passphrase
 * was in force when it was taken, forever.
 *
 * Two decisions worth stating.
 *
 * A FRESH SALT. Everywhere else in this file the salt is fixed for the life of
 * the vault - regenerating it on an ordinary save would be a bug, because the
 * old ciphertext could no longer be opened. A passphrase change is the one
 * moment where everything is being re-encrypted anyway, so a new salt costs
 * nothing and buys something real: with the salt reused, one PBKDF2 run per
 * candidate passphrase would test that candidate against an old backup and the
 * new record at once. Separate salts make an attacker do the work twice.
 *
 * VERIFY BEFORE THE CALLER WRITES. A half-applied passphrase change is an
 * unopenable vault, which is strictly worse than no change at all. So the new
 * record is decrypted here, with the new key, before it is handed back - the
 * caller only ever receives a record already proven to open.
 *
 * @throws {Error} code 'BAD_PASSPHRASE' if the current passphrase is wrong
 */
export async function changePassphrase(currentPassphrase, newPassphrase, record) {
  // Throws BAD_PASSPHRASE if the current one is wrong, which is the whole
  // authorisation check - there is nothing else to check it against.
  const { data } = await unlockVault(currentPassphrase, record);

  const salt = randomBytes(KDF.saltBytes);
  const kdfParams = { salt: bytesToBase64(salt), iterations: KDF.iterations };

  const key = await deriveKey(newPassphrase, salt, KDF.iterations);
  const next = await encryptVault(key, data, kdfParams);

  // Prove it opens. If this throws, nothing has been written and the caller
  // still holds a working vault.
  await decryptVault(key, next);

  return { key, record: next, kdfParams, data };
}

/**
 * Unlock an existing vault.
 * Re-derives the key using the salt + iteration count saved in the record.
 *
 * @returns {Promise<{key: CryptoKey, data: object, kdfParams: object}>}
 * @throws {Error} code 'BAD_PASSPHRASE' when decryption fails
 */
export async function unlockVault(passphrase, record) {
  const salt = base64ToBytes(record.kdf.salt);
  const iterations = record.kdf.iterations;

  const key = await deriveKey(passphrase, salt, iterations);

  let data;
  try {
    data = await decryptVault(key, record);
  } catch {
    // Do not leak which part failed - to an attacker "wrong passphrase" and
    // "corrupted vault" should look identical.
    const err = new Error('Wrong passphrase, or the vault file is damaged.');
    err.code = 'BAD_PASSPHRASE';
    throw err;
  }

  return { key, data, kdfParams: { salt: record.kdf.salt, iterations } };
}
