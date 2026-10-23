import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const KEY_LEN = 64;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt);
  return `$scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    if (passwordHash.startsWith('$scrypt$')) {
      const parts = passwordHash.split('$');
      const saltHex = parts[2];
      const hashHex = parts[3];
      if (!saltHex || !hashHex) return false;
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = await deriveKey(password, salt);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    }
    if (passwordHash.startsWith('$argon2')) {
      const argon2 = await import('@node-rs/argon2');
      return await argon2.verify(passwordHash, password);
    }
    return false;
  } catch {
    return false; // malformed hash
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends the same time as a real check. Used when the user does not exist, so
 * response timing does not reveal which phone numbers / emails are registered.
 */
export async function simulatePasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('timing-equaliser-not-a-real-password');
  await verifyPassword(await dummyHash, password);
}
