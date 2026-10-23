import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, tx, line, insertDraft } from './helpers.mjs';

let db;
let ctx; // owner of shop 1
let owner, tenant, branch, invPrefix;
let glass, handle, lock, hinge;
let partyDl, partyMh;

const q = async (c, sql, params = []) => (await tx(db.api, c, (cl) => cl.query(sql, params))).rows;
const one = async (c, sql, params) => (await q(c, sql, params))[0];
const val = async (c, sql, params) => Object.values(await one(c, sql, params))[0];

// Asserts the call is rejected with the given SQLSTATE.
async function blocked(promise, code, what) {
  await assert.rejects(
    promise,
    (err) => {
      assert.equal(err.code, code, `${what}: expected ${code}, got ${err.code} ${err.message}`);
      return true;
    },
    what,
  );
}

async function addProduct(sku, name, kind, hsn, unit, extra = {}) {
  const { id } = await one(
    ctx,
    `INSERT INTO erp.products (sku, name, kind, hsn_code, gst_rate, unit_code, measure)
     VALUES ($1, $2, $3, $4, 18, $5, $6) RETURNING id`,
    [sku, name, kind, hsn, unit, extra.measure ?? 'quantity'],
  );
  return { id, name, hsn, unit, gstRate: 18 };
}

const stockOf = (p) =>
  val(ctx, 'SELECT qty::float FROM erp.stock_balances WHERE product_id = $1', [p.id]);
const balanceOf = (partyId) =>
  val(ctx, 'SELECT balance::float FROM erp.v_party_balances WHERE party_id = $1', [partyId]);
const post = (c, id) => val(c, 'SELECT erp.post_sales_invoice($1)', [id]);
const draft = (c, header, lines) => tx(db.api, c, (cl) => insertDraft(cl, header, lines));
const walkIn = (extra = {}) => ({
  branch_id: branch,
  supply_type: 'b2c',
  customer_name: 'Walk-in',
  place_of_supply: '07',
  seller_state_code: '07',
  ...extra,
});

before(async () => {
  db = await createTestDatabase();

  ({ id: owner } = await one(
    {},
    `INSERT INTO erp.users (full_name, phone) VALUES ('Shop Owner', '9876543210') RETURNING id`,
  ));
  tenant = await val(
    { userId: owner },
    `SELECT erp.register_tenant('Sharma Glass House', 'MAIN', 'Main Shop', '07', '07ABCDE1234F1Z5')`,
  );
  ctx = { userId: owner, tenantId: tenant, requestId: 'req-1' };
  branch = await val(ctx, 'SELECT id FROM erp.branches');
  invPrefix =
    'MAIN' +
    (await val(ctx, `SELECT replace(substr(erp.financial_year_of(erp.today()), 3), '-', '')`)) +
    '/';

  glass = await addProduct('GL-CLR-5', 'Clear Float Glass 5mm', 'glass', '7005', 'SQFT', {
    measure: 'area',
  });
  handle = await addProduct('HW-HDL-8', 'SS Handle 8 inch', 'hardware', '8302', 'PCS');
  lock = await addProduct('HW-LOCK-1', 'Door Lock', 'hardware', '8301', 'PCS');
  hinge = await addProduct('HW-HNG-4', 'Hinge 4 inch', 'hardware', '8302', 'PCS');
  for (const [p, qty] of [
    [glass, 100],
    [handle, 50],
    [lock, 25],
    [hinge, 1000],
  ]) {
    await q(ctx, `SELECT erp.adjust_stock($1, $2, $3, 'Opening stock', true)`, [branch, p.id, qty]);
  }

  ({ id: partyDl } = await one(
    ctx,
    `INSERT INTO erp.parties (kind, name, gstin, state_code)
    VALUES ('customer', 'Delhi Fabricators', '07AAACB1234C1Z2', '07') RETURNING id`,
  ));
  ({ id: partyMh } = await one(
    ctx,
    `INSERT INTO erp.parties (kind, name, gstin, state_code)
    VALUES ('customer', 'Mumbai Interiors', '27AABCU9603R1ZM', '27') RETURNING id`,
  ));
});

after(() => db?.drop());

// -----------------------------------------------------------------------------
let inv1;

test('B2B intra-state invoice: number, stock, ledger, GSTIN snapshot', async () => {
  inv1 = await draft(
    ctx,
    {
      branch_id: branch,
      supply_type: 'b2b',
      party_id: partyDl,
      customer_name: 'Delhi Fabricators',
      customer_gstin: '07AAACB1234C1Z2',
      place_of_supply: '07',
      seller_state_code: '07',
      idempotency_key: 'client-key-001',
    },
    [
      // 2 pcs of 36" x 48" = 24 sq ft @ 75
      line(glass, 24, 75, { size_unit: 'inch', width: 36, height: 48, pieces: 2 }),
      line(handle, 4, 250),
    ],
  );

  assert.equal(await post(ctx, inv1), `${invPrefix}00001`);
  assert.equal(await stockOf(glass), 76);
  assert.equal(await stockOf(handle), 46);
  assert.equal(await balanceOf(partyDl), 3304); // 2800 + 18% GST
  const inv = await one(
    ctx,
    'SELECT seller_gstin, grand_total::float FROM erp.sales_invoices WHERE id = $1',
    [inv1],
  );
  assert.deepEqual(inv, { seller_gstin: '07ABCDE1234F1Z5', grand_total: 3304 });
});

test('posting twice is idempotent (same number, stock reduced once)', async () => {
  assert.equal(await post(ctx, inv1), `${invPrefix}00001`);
  assert.equal(await stockOf(glass), 76);
});

test('double submit with the same idempotency key is rejected', async () => {
  await blocked(
    draft(ctx, walkIn({ idempotency_key: 'client-key-001' }), [line(handle, 1, 10)]),
    '23505',
    'duplicate request',
  );
});

test('posted invoices are frozen', async () => {
  await blocked(
    q(ctx, `UPDATE erp.sales_invoices SET customer_name = 'X' WHERE id = $1`, [inv1]),
    'ERP03',
    'edit',
  );
  await blocked(
    q(ctx, `UPDATE erp.sales_invoices SET amount_paid = 3304 WHERE id = $1`, [inv1]),
    'ERP03',
    'mark paid',
  );
  await blocked(q(ctx, 'DELETE FROM erp.sales_invoices WHERE id = $1', [inv1]), 'ERP03', 'delete');
  await blocked(
    q(ctx, 'UPDATE erp.sales_invoice_lines SET rate = 1 WHERE invoice_id = $1', [inv1]),
    'ERP03',
    'edit line',
  );
  await blocked(
    q(
      ctx,
      `INSERT INTO erp.sales_invoice_lines (invoice_id, line_no, product_id, description, hsn_code,
    unit_code, qty, rate, taxable_value, gst_rate) VALUES ($1, 9, $2, 'x', '8302', 'PCS', 1, 0, 0, 0)`,
      [inv1, handle.id],
    ),
    'ERP03',
    'add line',
  );
});

test('the API role cannot bypass business rules', async () => {
  await blocked(
    q(
      ctx,
      `INSERT INTO erp.sales_invoices (branch_id, supply_type, customer_name, place_of_supply,
    seller_state_code, status, invoice_no, financial_year, posted_at)
    VALUES ($1, 'b2c', 'Fake', '07', '07', 'posted', 'FAKE/1', '2026-27', now())`,
      [branch],
    ),
    'ERP03',
    'insert an already-posted invoice',
  );
  const d = await draft(ctx, walkIn(), [line(handle, 1, 100)]);
  await blocked(
    q(
      ctx,
      `UPDATE erp.sales_invoices SET status = 'posted', invoice_no = 'X', financial_year = '2026-27',
    posted_at = now() WHERE id = $1`,
      [d],
    ),
    'ERP03',
    'post by UPDATE instead of the function',
  );
  await q(ctx, 'DELETE FROM erp.sales_invoices WHERE id = $1', [d]);

  await blocked(q(ctx, 'UPDATE erp.stock_balances SET qty = 999'), '42501', 'edit stock');
  await blocked(
    q(
      ctx,
      `INSERT INTO erp.stock_movements (branch_id, product_id, movement_type, qty_change,
    balance_after) VALUES ($1, $2, 'purchase', 5, 5)`,
      [branch, glass.id],
    ),
    '42501',
    'fake movement',
  );
  await blocked(
    q(ctx, `SELECT erp.apply_stock_movement($1, $2, 'purchase', 5)`, [branch, glass.id]),
    '42501',
    'internal stock function',
  );
  await blocked(
    q(ctx, `SELECT erp.next_document_number($1, 'sales_invoice', current_date)`, [branch]),
    '42501',
    'internal numbering function',
  );
  await blocked(
    q(
      ctx,
      `INSERT INTO erp.party_ledger (party_id, entry_date, entry_type, credit)
    VALUES ($1, current_date, 'receipt', 3304)`,
      [partyDl],
    ),
    '42501',
    'fake ledger entry',
  );
  await blocked(
    q(ctx, 'UPDATE audit.row_changes SET user_id = NULL'),
    '42501',
    'tamper with audit',
  );
  await blocked(q(ctx, 'DELETE FROM audit.row_changes'), '42501', 'delete audit');
  await blocked(
    q(ctx, 'DELETE FROM erp.products WHERE id = $1', [glass.id]),
    '42501',
    'hard-delete product',
  );
  await blocked(
    q(ctx, `SELECT erp.adjust_stock($1, $2, -5, '')`, [branch, glass.id]),
    'ERP04',
    'adjust without reason',
  );
});

test('GST data rules', async () => {
  await blocked(
    draft(ctx, walkIn({ supply_type: 'b2b' }), [line(handle, 1, 100)]),
    '23514',
    'B2B without GSTIN',
  );
  await blocked(
    draft(ctx, walkIn({ place_of_supply: '27' }), [line(handle, 1, 100)]),
    '23514',
    'CGST/SGST on an inter-state sale',
  );
  await blocked(
    draft(ctx, walkIn(), [{ ...line(handle, 1, 100), cgst_amount: 5, sgst_amount: 5 }]),
    '23514',
    'tax not matching the GST rate',
  );
  await blocked(
    q(
      ctx,
      `INSERT INTO erp.products (sku, name, kind, hsn_code, gst_rate, unit_code)
    VALUES ('BAD', 'Bad', 'hardware', '83', 18, 'PCS')`,
    ),
    '23514',
    'invalid HSN',
  );
  await blocked(
    q(
      ctx,
      `INSERT INTO erp.parties (kind, name, gstin, state_code)
    VALUES ('customer', 'Wrong state', '07AAACB1234C1Z2', '27')`,
    ),
    '23514',
    'GSTIN state mismatch',
  );

  const backdated = await draft(
    ctx,
    walkIn({ invoice_date: new Date(Date.now() - 86_400_000 * 2) }),
    [line(handle, 1, 100)],
  );
  await blocked(post(ctx, backdated), 'ERP04', 'back-dated invoice after a newer one');
  await q(ctx, 'DELETE FROM erp.sales_invoices WHERE id = $1', [backdated]);
});

let inv2;
test('inter-state B2B invoice uses IGST only', async () => {
  inv2 = await draft(
    ctx,
    {
      branch_id: branch,
      supply_type: 'b2b',
      party_id: partyMh,
      customer_name: 'Mumbai Interiors',
      customer_gstin: '27AABCU9603R1ZM',
      place_of_supply: '27',
      seller_state_code: '07',
    },
    [line(handle, 3, 250, { interState: true })],
  );
  assert.equal(await post(ctx, inv2), `${invPrefix}00002`);
  const r = await one(
    ctx,
    'SELECT cgst_amount::float c, igst_amount::float i FROM erp.sales_invoices WHERE id = $1',
    [inv2],
  );
  assert.deepEqual(r, { c: 0, i: 135 });
});

let inv3;
test('atomicity: a failing post changes nothing and wastes no number', async () => {
  inv3 = await draft(ctx, walkIn(), [line(handle, 5, 50), line(glass, 1000, 1)]);
  await blocked(post(ctx, inv3), 'ERP01', 'sell 1000 sq ft with 76 in stock');
  assert.equal(await stockOf(handle), 43, 'handle line was rolled back too');
  assert.equal(
    await val(ctx, 'SELECT status FROM erp.sales_invoices WHERE id = $1', [inv3]),
    'draft',
  );

  await q(
    ctx,
    'UPDATE erp.sales_invoice_lines SET qty = 10, rate = 100 WHERE invoice_id = $1 AND line_no = 2',
    [inv3],
  );
  assert.equal(await post(ctx, inv3), `${invPrefix}00003`, 'no gap in numbering');
});

test('header totals must equal the lines; drafts can be deleted', async () => {
  const d = await draft(
    ctx,
    walkIn({ taxable_value: 999, cgst_amount: 0, sgst_amount: 0, grand_total: 999 }),
    [{ ...line(handle, 1, 100), gst_rate: 0, cgst_amount: 0, sgst_amount: 0 }],
  );
  await blocked(post(ctx, d), 'ERP04', 'mismatched totals');
  await q(ctx, 'DELETE FROM erp.sales_invoices WHERE id = $1', [d]);
  assert.equal(
    await val(ctx, 'SELECT count(*)::int FROM erp.sales_invoice_lines WHERE invoice_id = $1', [d]),
    0,
  );
});

let rc1;
test('receipts reduce the balance; over-payment is rejected', async () => {
  rc1 = await tx(db.api, ctx, async (c) => {
    const {
      rows: [r],
    } = await c.query(
      `INSERT INTO erp.receipts (branch_id, party_id, mode, amount, reference_no)
      VALUES ($1, $2, 'upi', 2000, 'UTR123') RETURNING id`,
      [branch, partyDl],
    );
    await c.query(
      'INSERT INTO erp.receipt_allocations (receipt_id, invoice_id, amount) VALUES ($1, $2, 2000)',
      [r.id, inv1],
    );
    return r.id;
  });
  assert.match(await val(ctx, 'SELECT erp.post_receipt($1)', [rc1]), /^MAINR\d{4}\/00001$/);
  assert.equal(
    await val(ctx, 'SELECT amount_paid::float FROM erp.sales_invoices WHERE id = $1', [inv1]),
    2000,
  );
  assert.equal(await balanceOf(partyDl), 1304);

  const rc2 = await tx(db.api, ctx, async (c) => {
    const {
      rows: [r],
    } = await c.query(
      `INSERT INTO erp.receipts (branch_id, party_id, mode, amount)
      VALUES ($1, $2, 'cash', 2000) RETURNING id`,
      [branch, partyDl],
    );
    await c.query(
      'INSERT INTO erp.receipt_allocations (receipt_id, invoice_id, amount) VALUES ($1, $2, 2000)',
      [r.id, inv1],
    );
    return r.id;
  });
  await blocked(q(ctx, 'SELECT erp.post_receipt($1)', [rc2]), 'ERP04', 'over-payment');
  await blocked(
    q(ctx, `SELECT erp.cancel_sales_invoice($1, 'wrong size')`, [inv1]),
    'ERP02',
    'cancel a paid invoice',
  );
});

test('cancellation reverses stock and ledger', async () => {
  await q(ctx, `SELECT erp.cancel_receipt($1, 'cheque bounced')`, [rc1]);
  await q(ctx, `SELECT erp.cancel_sales_invoice($1, 'customer returned the order')`, [inv1]);
  assert.equal(await stockOf(glass), 90); // 100 - 24 - 10 + 24
  assert.equal(await balanceOf(partyDl), 0);
  const consistent = await val(
    ctx,
    `SELECT bool_and(b.qty = m.total) FROM erp.stock_balances b
    JOIN (SELECT product_id, sum(qty_change) total FROM erp.stock_movements GROUP BY product_id) m USING (product_id)`,
  );
  assert.equal(consistent, true, 'every balance equals the sum of its movements');
  await blocked(
    q(ctx, `SELECT erp.cancel_sales_invoice($1, 'again')`, [inv1]),
    'ERP02',
    'cancel twice',
  );
});

test('optimistic locking rejects a stale edit', async () => {
  const first = await q(
    ctx,
    'UPDATE erp.products SET retail_price = 95 WHERE id = $1 AND version = 1 RETURNING version',
    [glass.id],
  );
  const second = await q(
    ctx,
    'UPDATE erp.products SET retail_price = 99 WHERE id = $1 AND version = 1 RETURNING version',
    [glass.id],
  );
  assert.deepEqual(first, [{ version: 2 }]);
  assert.deepEqual(second, [], 'second editor must reload');
});

test('audit trail records who changed what, when, from which request', async () => {
  const rows = await q(
    ctx,
    `SELECT action, changed_fields, user_id, request_id FROM audit.row_changes
    WHERE table_name = 'sales_invoices' AND record_id = $1 ORDER BY id`,
    [inv1],
  );
  assert.ok(rows.length >= 5, 'create, post, payment, payment reversal, cancel');
  assert.ok(rows.every((r) => r.user_id === owner && r.request_id === 'req-1'));
  assert.ok(rows.some((r) => r.changed_fields?.includes('cancel_reason')));

  const price = await one(
    ctx,
    `SELECT old_data, new_data FROM audit.row_changes
    WHERE table_name = 'products' AND record_id = $1 AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`,
    [glass.id],
  );
  assert.equal(price.old_data.retail_price, 0);
  assert.equal(price.new_data.retail_price, 95);

  await q({}, `UPDATE erp.users SET password_hash = 'secret-hash' WHERE id = $1`, [owner]);
  const leaked = await val(
    {},
    `SELECT count(*)::int FROM audit.row_changes WHERE table_name = 'users'
    AND (new_data ? 'password_hash' OR old_data ? 'password_hash')`,
  );
  assert.equal(leaked, 0, 'password hash never copied to the audit log');

  await q(ctx, `SELECT audit.log_event('invoice.printed', 'sales_invoice', $1, '{"copies": 2}')`, [
    inv2,
  ]);
  assert.equal(
    await val(ctx, `SELECT count(*)::int FROM audit.events WHERE event_type = 'invoice.printed'`),
    1,
  );
});

test('roles: an accountant can read but not cancel or adjust stock', async () => {
  const { id: acct } = await one(
    {},
    `INSERT INTO erp.users (full_name, phone) VALUES ('Accountant', '9800000001') RETURNING id`,
  );
  await q(ctx, `INSERT INTO erp.tenant_members (user_id, role) VALUES ($1, 'accountant')`, [acct]);
  const actx = { userId: acct, tenantId: tenant };
  assert.ok((await val(actx, 'SELECT count(*)::int FROM erp.sales_invoices')) > 0);
  await blocked(
    q(actx, `SELECT erp.cancel_sales_invoice($1, 'x')`, [inv2]),
    '42501',
    'accountant cancels',
  );
  await blocked(
    q(actx, `SELECT erp.adjust_stock($1, $2, 5, 'x')`, [branch, glass.id]),
    '42501',
    'accountant adjusts',
  );
});

test('tenant isolation: shop 2 can neither see nor touch shop 1', async () => {
  const { id: owner2 } = await one(
    {},
    `INSERT INTO erp.users (full_name, phone) VALUES ('Other Owner', '9123456789') RETURNING id`,
  );
  const tenant2 = await val(
    { userId: owner2 },
    `SELECT erp.register_tenant('Gupta Aluminium', 'GA', 'Gupta Main', '09')`,
  );
  const c2 = { userId: owner2, tenantId: tenant2 };
  const branch2 = await val(c2, 'SELECT id FROM erp.branches');

  assert.equal(await val(c2, 'SELECT count(*)::int FROM erp.products'), 0);
  assert.equal(await val(c2, 'SELECT count(*)::int FROM erp.sales_invoices'), 0);
  assert.equal(await val(c2, 'SELECT count(*)::int FROM erp.party_ledger'), 0);
  assert.equal(
    await val(c2, 'SELECT count(*)::int FROM audit.row_changes WHERE tenant_id = $1', [tenant]),
    0,
  );
  assert.equal(await val(c2, 'SELECT count(*)::int FROM erp.tenants'), 1);

  await blocked(
    q(
      c2,
      `INSERT INTO erp.products (tenant_id, sku, name, kind, hsn_code, gst_rate, unit_code)
    VALUES ($1, 'X', 'X', 'hardware', '8302', 18, 'PCS')`,
      [tenant],
    ),
    '42501',
    'write into shop 1',
  );
  await blocked(
    draft(
      c2,
      {
        branch_id: branch2,
        supply_type: 'b2b',
        party_id: partyDl,
        customer_name: 'Stolen',
        customer_gstin: '07AAACB1234C1Z2',
        place_of_supply: '09',
        seller_state_code: '09',
      },
      [],
    ),
    '23503',
    'use shop 1 customer',
  );
  await blocked(post(c2, inv3), 'ERP04', 'post shop 1 invoice');
  await blocked(
    q({ userId: owner2, tenantId: tenant }, `SELECT erp.post_sales_invoice($1)`, [inv3]),
    '42501',
    'forged tenant context without membership',
  );
});

// -----------------------------------------------------------------------------
// Real concurrency: many connections at the same time.
// -----------------------------------------------------------------------------
test('race: 20 cashiers sell 2 locks each with 25 in stock', async () => {
  const sell = (i) =>
    tx(db.api, ctx, async (c) => {
      const id = await insertDraft(c, walkIn({ customer_name: `Race ${i}` }), [line(lock, 2, 500)]);
      await c.query('SELECT pg_sleep(0.2)'); // everyone reaches the post together
      const {
        rows: [r],
      } = await c.query('SELECT erp.post_sales_invoice($1) AS no', [id]);
      return r.no;
    });
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => sell(i)));

  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 12, '12 x 2 = 24 of 25 sold');
  assert.ok(
    failed.every((r) => r.reason.code === 'ERP01'),
    `only "insufficient stock" errors, got: ${failed.map((r) => r.reason.code).join(',')}`,
  );
  assert.equal(await stockOf(lock), 1, 'no overselling, no lost update');

  const nums = await q(
    ctx,
    `SELECT split_part(invoice_no, '/', 2)::int n FROM erp.sales_invoices
    WHERE branch_id = $1 AND invoice_no IS NOT NULL ORDER BY 1`,
    [branch],
  );
  assert.deepEqual(
    nums.map((r) => r.n),
    nums.map((_, i) => i + 1),
    'invoice numbers unique and gap-free',
  );
});

test('no deadlocks: concurrent invoices list the same items in opposite order', async () => {
  const sell = (i) =>
    tx(db.api, ctx, async (c) => {
      const lines = [line(hinge, 1, 40), line(handle, 1, 250)];
      const id = await insertDraft(
        c,
        walkIn({ customer_name: `Deadlock ${i}` }),
        i % 2 ? lines.reverse() : lines,
      );
      await c.query('SELECT pg_sleep(0.1)');
      await c.query('SELECT erp.post_sales_invoice($1)', [id]);
    });
  const before = await stockOf(hinge);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => sell(i)));
  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r) => `${r.reason.code} ${r.reason.message}`);
  assert.deepEqual(errors, []);
  assert.equal(await stockOf(hinge), before - 20);
});
