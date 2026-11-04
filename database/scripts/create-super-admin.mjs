import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import pg from 'pg';

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const KEY_LEN = 64;

function deriveKey(password, salt) {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEY_LEN, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt);
  return `$scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('ERROR: DATABASE_URL environment variable is required.');
  console.error('Usage: DATABASE_URL="postgres://..." node database/scripts/create-super-admin.mjs [email_or_phone] [password] [full_name]');
  process.exit(1);
}

const identifier = process.argv[2] || 'admin@glass-erp.com';
const password = process.argv[3] || 'SuperAdmin@2026';
const fullName = process.argv[4] || 'Platform Super Admin';

const isEmail = identifier.includes('@');
const email = isEmail ? identifier.toLowerCase() : null;
const phone = isEmail ? null : identifier;

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

try {
  const passwordHash = await hashPassword(password);

  // Check if user exists
  const existing = await client.query(
    'SELECT id, email, phone FROM erp.users WHERE (email IS NOT NULL AND lower(email) = lower($1)) OR (phone IS NOT NULL AND phone = $2)',
    [email, phone],
  );

  let userId;
  if (existing.rows.length > 0) {
    userId = existing.rows[0].id;
    await client.query(
      `UPDATE erp.users
       SET password_hash = $1, is_platform_admin = true, status = 'active', failed_login_count = 0, locked_until = NULL, updated_at = now()
       WHERE id = $2`,
      [passwordHash, userId],
    );
    console.log(`\n✅ Existing user updated to Super Admin:`);
  } else {
    const res = await client.query(
      `INSERT INTO erp.users (full_name, email, phone, password_hash, is_platform_admin, status)
       VALUES ($1, $2, $3, $4, true, 'active')
       RETURNING id`,
      [fullName, email, phone, passwordHash],
    );
    userId = res.rows[0].id;
    console.log(`\n✅ New Super Admin created successfully:`);
  }

  console.log('----------------------------------------------------');
  console.log(`User ID   : ${userId}`);
  console.log(`Full Name : ${fullName}`);
  console.log(`Login ID  : ${identifier}`);
  console.log(`Password  : ${password}`);
  console.log(`Role      : Platform Super Admin (is_platform_admin = true)`);
  console.log('----------------------------------------------------\n');
} catch (err) {
  console.error('Failed to create/update Super Admin:', err.message);
  process.exit(1);
} finally {
  await client.end();
}
