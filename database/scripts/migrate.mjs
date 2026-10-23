// Applies database/migrations/*.sql in file-name order, each in its own
// transaction, and records them in public.schema_migrations with a checksum.
//
//   * Already-applied files are skipped, so it is safe to run on every deploy.
//   * If an applied file was changed afterwards, it stops (checksum mismatch):
//     changes after go-live must be NEW files.
//   * An advisory lock stops two deploys from migrating at the same time.
//
// Connect as a superuser (000_roles.sql creates roles). Connection from
// DATABASE_URL, or the standard PGHOST / PGPORT / PGUSER / PGPASSWORD /
// PGDATABASE variables.
//
//   node database/scripts/migrate.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_KEY = 20261019;

const client = new pg.Client(
  process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {},
);
await client.connect();

try {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename   text        PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const applied = new Map(
    (await client.query('SELECT filename, checksum FROM public.schema_migrations')).rows.map(
      (r) => [r.filename, r.checksum],
    ),
  );

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let ran = 0;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(`${file} was changed after it was applied. Add a new migration instead.`);
      }
      continue;
    }
    process.stdout.write(`applying ${file} ... `);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw err;
    }
    console.log('ok');
    ran++;
  }
  console.log(ran ? `${ran} migration(s) applied.` : 'Database is up to date.');
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  await client.end();
}
