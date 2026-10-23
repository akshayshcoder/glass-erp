// Test harness: creates a throw-away database, applies every migration as the
// superuser, and hands back a pool that connects as the API role, exactly like
// the real backend will.
//
//   DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const API_ROLE = 'erp_api_test';

export async function createTestDatabase() {
  // Test files run in parallel: the name must be unique, not just a timestamp.
  const name = `erp_test_${Date.now()}_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  // Roles are server-wide: parallel test files must not create them at the same time.
  await admin.query('SELECT pg_advisory_lock(20261019)');

  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${name}`;
  const su = new pg.Client({ connectionString: dbUrl.toString() });
  await su.connect();
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await su.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  await su.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${API_ROLE}') THEN
        CREATE ROLE ${API_ROLE} LOGIN PASSWORD 'test';
      END IF;
    END $$;
    GRANT erp_app TO ${API_ROLE};`);
  await su.end();
  await admin.query('SELECT pg_advisory_unlock(20261019)');

  const apiUrl = new URL(dbUrl);
  apiUrl.username = API_ROLE;
  apiUrl.password = 'test';
  const api = new pg.Pool({ connectionString: apiUrl.toString(), max: 30 });
  api.on('error', () => {}); // idle connection dropped by the server (e.g. at DROP DATABASE)

  return {
    api,
    apiUrl: apiUrl.toString(),
    async drop() {
      await api.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

// The request pattern every API call must follow: one transaction, context set
// transaction-locally first, COMMIT on success, ROLLBACK on any error.
export async function tx(pool, ctx, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
              set_config('app.request_id', $3, true)`,
      [ctx.tenantId ?? '', ctx.userId ?? '', ctx.requestId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

// Builds a sales line with correct GST split (CGST+SGST same state, IGST otherwise).
export function line(product, qty, rate, { interState = false, ...extra } = {}) {
  const taxable = round2(qty * rate);
  const tax = (taxable * product.gstRate) / 100;
  const half = round2(tax / 2);
  return {
    product_id: product.id,
    description: product.name,
    hsn_code: product.hsn,
    unit_code: product.unit,
    qty,
    rate,
    taxable_value: taxable,
    gst_rate: product.gstRate,
    cgst_amount: interState ? 0 : half,
    sgst_amount: interState ? 0 : half,
    igst_amount: interState ? round2(tax) : 0,
    ...extra,
  };
}

const DOC_TABLES = {
  sales_invoices: ['sales_invoice_lines', 'invoice_id'],
  purchase_bills: ['purchase_bill_lines', 'bill_id'],
  credit_notes: ['credit_note_lines', 'credit_note_id'],
  quotations: ['quotation_lines', 'quotation_id'],
};

// Inserts a draft invoice + lines. Header totals are summed from the lines
// unless the header gives them explicitly.
export function insertDraft(client, header, lines) {
  return insertDoc(client, 'sales_invoices', header, lines);
}

// Same for any document table (purchase_bills, credit_notes, quotations, ...).
export async function insertDoc(client, table, header, lines) {
  const [lineTable, fk] = DOC_TABLES[table];
  const sum = (k) => round2(lines.reduce((s, l) => s + Number(l[k] ?? 0), 0));
  const totals = {
    taxable_value: sum('taxable_value'),
    cgst_amount: sum('cgst_amount'),
    sgst_amount: sum('sgst_amount'),
    igst_amount: sum('igst_amount'),
  };
  totals.grand_total = round2(
    totals.taxable_value + totals.cgst_amount + totals.sgst_amount + totals.igst_amount,
  );
  const h = { ...totals, ...header };

  const hk = Object.keys(h);
  const {
    rows: [inv],
  } = await client.query(
    `INSERT INTO erp.${table} (${hk.join(', ')})
     VALUES (${hk.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(h),
  );
  for (const [i, l] of lines.entries()) {
    const row = { [fk]: inv.id, line_no: i + 1, ...l };
    const lk = Object.keys(row);
    await client.query(
      `INSERT INTO erp.${lineTable} (${lk.join(', ')})
       VALUES (${lk.map((_, j) => `$${j + 1}`).join(', ')})`,
      Object.values(row),
    );
  }
  return inv.id;
}
