import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, tx, line, insertDoc } from './helpers.mjs';

let db;
let ctx;
let owner, tenant, branch, fy, period;
let glass, handle, lock;
let supplierGj, customer;

const q = async (c, sql, params = []) => (await tx(db.api, c, (cl) => cl.query(sql, params))).rows;
const one = async (c, sql, params) => (await q(c, sql, params))[0];
const val = async (c, sql, params) => Object.values(await one(c, sql, params))[0];
const doc = (c, table, header, lines) => tx(db.api, c, (cl) => insertDoc(cl, table, header, lines));
const call = (c, fn, ...args) =>
  val(c, `SELECT erp.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args);

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

async function addProduct(sku, name, hsn, unit) {
  const { id } = await one(
    ctx,
    `INSERT INTO erp.products (sku, name, kind, hsn_code, gst_rate, unit_code)
    VALUES ($1, $2, 'hardware', $3, 18, $4) RETURNING id`,
    [sku, name, hsn, unit],
  );
  return { id, name, hsn, unit, gstRate: 18 };
}
async function addMember(name, phone, role) {
  const { id } = await one(
    {},
    'INSERT INTO erp.users (full_name, phone) VALUES ($1, $2) RETURNING id',
    [name, phone],
  );
  await q(ctx, 'INSERT INTO erp.tenant_members (user_id, role) VALUES ($1, $2)', [id, role]);
  return { userId: id, tenantId: tenant };
}

const stockOf = (p) =>
  val(ctx, 'SELECT qty::float FROM erp.stock_balances WHERE product_id = $1', [p.id]);
const balanceOf = (id) =>
  val(ctx, 'SELECT balance::float FROM erp.v_party_balances WHERE party_id = $1', [id]);

const purchaseHeader = (no, extra = {}) => ({
  branch_id: branch,
  supplier_id: supplierGj,
  supplier_name: 'Gujarat Glass Works',
  supplier_gstin: '24AAACG1234K1Z9',
  supplier_invoice_no: no,
  supplier_invoice_date: new Date(),
  supplier_state_code: '24',
  buyer_state_code: '07',
  ...extra,
});
const saleHeader = (extra = {}) => ({
  branch_id: branch,
  supply_type: 'b2b',
  party_id: customer,
  customer_name: 'Delhi Fabricators',
  customer_gstin: '07AAACB1234C1Z2',
  place_of_supply: '07',
  seller_state_code: '07',
  ...extra,
});
const cnHeader = (invoiceId, reason, extra = {}) => ({
  branch_id: branch,
  invoice_id: invoiceId,
  party_id: customer,
  reason,
  customer_name: 'Delhi Fabricators',
  customer_gstin: '07AAACB1234C1Z2',
  place_of_supply: '07',
  seller_state_code: '07',
  ...extra,
});

before(async () => {
  db = await createTestDatabase();
  ({ id: owner } = await one(
    {},
    `INSERT INTO erp.users (full_name, phone) VALUES ('Owner', '9876543210') RETURNING id`,
  ));
  tenant = await val(
    { userId: owner },
    `SELECT erp.register_tenant('Sharma Glass House', 'MAIN', 'Main Shop', '07', '07ABCDE1234F1Z5')`,
  );
  ctx = { userId: owner, tenantId: tenant, requestId: 'req-2' };
  branch = await val(ctx, 'SELECT id FROM erp.branches');
  fy = await val(ctx, `SELECT replace(substr(erp.financial_year_of(erp.today()), 3), '-', '')`);
  period = await val(ctx, `SELECT to_char(erp.today(), 'YYYY-MM')`);

  glass = await addProduct('GL-CLR-5', 'Clear Float Glass 5mm', '7005', 'SQFT');
  handle = await addProduct('HW-HDL-8', 'SS Handle 8 inch', '8302', 'PCS');
  lock = await addProduct('HW-LOCK-1', 'Door Lock', '8301', 'PCS');

  ({ id: supplierGj } = await one(
    ctx,
    `INSERT INTO erp.parties (kind, name, gstin, state_code)
    VALUES ('supplier', 'Gujarat Glass Works', '24AAACG1234K1Z9', '24') RETURNING id`,
  ));
  ({ id: customer } = await one(
    ctx,
    `INSERT INTO erp.parties (kind, name, gstin, state_code)
    VALUES ('customer', 'Delhi Fabricators', '07AAACB1234C1Z2', '07') RETURNING id`,
  ));
});

after(() => db?.drop());

// ----------------------------------------------------------------------------- purchases
let bill1;

test('purchase bill (inter-state, IGST): stock in, supplier ledger, last purchase price', async () => {
  bill1 = await doc(ctx, 'purchase_bills', purchaseHeader('GJ/101'), [
    line(glass, 500, 40, { interState: true }), // 20000 + 3600 IGST
    line(handle, 100, 150, { interState: true }), // 15000 + 2700 IGST
  ]);
  assert.equal(await call(ctx, 'post_purchase_bill', bill1), `MAINP${fy}/00001`);
  assert.equal(await stockOf(glass), 500);
  assert.equal(await stockOf(handle), 100);
  assert.equal(await balanceOf(supplierGj), -41300, 'we owe the supplier 41,300');
  assert.equal(
    await val(ctx, 'SELECT purchase_price::float FROM erp.products WHERE id = $1', [glass.id]),
    40,
  );
});

test('the same supplier bill cannot be entered twice', async () => {
  await blocked(
    doc(ctx, 'purchase_bills', purchaseHeader('gj/101'), [
      line(lock, 1, 100, { interState: true }),
    ]),
    '23505',
    'duplicate supplier bill number (case-insensitive)',
  );
});

test('purchase rules: supplier type, GST split', async () => {
  const wrongParty = await doc(
    ctx,
    'purchase_bills',
    purchaseHeader('X-1', {
      supplier_id: customer,
      supplier_gstin: null,
      supplier_state_code: '07',
    }),
    [line(lock, 1, 100)],
  );
  await blocked(
    call(ctx, 'post_purchase_bill', wrongParty),
    'ERP04',
    'a customer used as supplier',
  );
  await q(ctx, 'DELETE FROM erp.purchase_bills WHERE id = $1', [wrongParty]);

  await blocked(
    doc(ctx, 'purchase_bills', purchaseHeader('X-2'), [line(lock, 1, 100)]),
    '23514',
    'CGST/SGST on an inter-state purchase',
  );
});

test('supplier payment: partial, over-payment blocked, paid bill cannot be cancelled', async () => {
  const pay = await tx(db.api, ctx, async (c) => {
    const {
      rows: [p],
    } = await c.query(
      `INSERT INTO erp.supplier_payments (branch_id, supplier_id, mode, amount, reference_no)
      VALUES ($1, $2, 'bank_transfer', 30000, 'NEFT001') RETURNING id`,
      [branch, supplierGj],
    );
    await c.query(
      'INSERT INTO erp.supplier_payment_allocations (payment_id, bill_id, amount) VALUES ($1, $2, 30000)',
      [p.id, bill1],
    );
    return p.id;
  });
  assert.equal(await call(ctx, 'post_supplier_payment', pay), `MAINV${fy}/00001`);
  assert.equal(await balanceOf(supplierGj), -11300);

  const over = await tx(db.api, ctx, async (c) => {
    const {
      rows: [p],
    } = await c.query(
      `INSERT INTO erp.supplier_payments (branch_id, supplier_id, mode, amount)
      VALUES ($1, $2, 'cash', 20000) RETURNING id`,
      [branch, supplierGj],
    );
    await c.query(
      'INSERT INTO erp.supplier_payment_allocations (payment_id, bill_id, amount) VALUES ($1, $2, 20000)',
      [p.id, bill1],
    );
    return p.id;
  });
  await blocked(call(ctx, 'post_supplier_payment', over), 'ERP04', 'pay more than the bill');
  await blocked(
    call(ctx, 'cancel_purchase_bill', bill1, 'wrong entry'),
    'ERP02',
    'cancel a paid bill',
  );
});

test('cancelling a purchase whose goods were already sold is refused', async () => {
  const b = await doc(ctx, 'purchase_bills', purchaseHeader('GJ/102'), [
    line(lock, 10, 300, { interState: true }),
  ]);
  await call(ctx, 'post_purchase_bill', b);
  const s = await doc(ctx, 'sales_invoices', saleHeader(), [line(lock, 8, 450)]);
  await call(ctx, 'post_sales_invoice', s);
  await blocked(
    call(ctx, 'cancel_purchase_bill', b, 'wrong supplier'),
    'ERP01',
    'stock would go negative',
  );
  assert.equal(await stockOf(lock), 2);
});

test('opening balance from the paper books: once per party', async () => {
  await q(ctx, 'SELECT erp.post_opening_balance($1, 5000, $2)', [customer, '2026-04-01']);
  await blocked(
    q(ctx, 'SELECT erp.post_opening_balance($1, 100, $2)', [customer, '2026-04-01']),
    '23505',
    'second opening balance',
  );
});

// ----------------------------------------------------------------------------- credit notes
let inv;

test('sales return with restock: stock back, customer credited, invoice tracks credit', async () => {
  inv = await doc(ctx, 'sales_invoices', saleHeader(), [
    line(handle, 10, 250), // 2500 + 450 GST
    line(glass, 50, 80), // 4000 + 720 GST
  ]);
  await call(ctx, 'post_sales_invoice', inv);
  const balance0 = await balanceOf(customer);

  const cn = await doc(ctx, 'credit_notes', cnHeader(inv, 'sales_return', { restock: true }), [
    line(handle, 4, 250),
  ]);
  assert.equal(await call(ctx, 'post_credit_note', cn), `MAINCN${fy}/00001`);
  assert.equal(await stockOf(handle), 94); // 100 - 10 + 4
  assert.equal(await balanceOf(customer), balance0 - 1180);
  const o = await one(
    ctx,
    'SELECT amount_credited::float c, balance_due::float d FROM erp.v_invoice_outstanding WHERE invoice_id = $1',
    [inv],
  );
  assert.deepEqual(o, { c: 1180, d: 7670 - 1180 });
});

test('credit note rules', async () => {
  const tooMany = await doc(ctx, 'credit_notes', cnHeader(inv, 'sales_return', { restock: true }), [
    line(handle, 7, 250),
  ]);
  await blocked(call(ctx, 'post_credit_note', tooMany), 'ERP04', 'return 4 + 7 of 10 sold');

  const notSold = await doc(ctx, 'credit_notes', cnHeader(inv, 'sales_return'), [
    line(lock, 1, 450),
  ]);
  await blocked(
    call(ctx, 'post_credit_note', notSold),
    'ERP04',
    'return a product not on the invoice',
  );

  const tooMuch = await doc(ctx, 'credit_notes', cnHeader(inv, 'rate_difference'), [
    line(glass, 0, 0, { taxable_value: 9000, cgst_amount: 810, sgst_amount: 810 }),
  ]);
  await blocked(
    call(ctx, 'post_credit_note', tooMuch),
    'ERP04',
    'credit more than the invoice value',
  );

  await blocked(
    doc(ctx, 'credit_notes', cnHeader(inv, 'discount', { restock: true }), [
      line(glass, 0, 0, { taxable_value: 100, cgst_amount: 9, sgst_amount: 9 }),
    ]),
    '23514',
    'restock on a non-return note',
  );

  const otherCustomer = await doc(
    ctx,
    'credit_notes',
    cnHeader(inv, 'discount', { party_id: null, customer_gstin: null }),
    [line(glass, 0, 0, { taxable_value: 100, cgst_amount: 9, sgst_amount: 9 })],
  );
  await blocked(
    call(ctx, 'post_credit_note', otherCustomer),
    'ERP04',
    'note for a different customer',
  );

  for (const id of [tooMany, notSold, tooMuch, otherCustomer]) {
    await q(ctx, 'DELETE FROM erp.credit_notes WHERE id = $1', [id]);
  }
  await blocked(
    call(ctx, 'cancel_sales_invoice', inv, 'x'),
    'ERP02',
    'cancel an invoice that has credit notes',
  );
});

test('rate-difference credit note changes value only, not stock', async () => {
  const cn = await doc(ctx, 'credit_notes', cnHeader(inv, 'rate_difference'), [
    line(glass, 0, 0, { taxable_value: 500, cgst_amount: 45, sgst_amount: 45 }),
  ]);
  await call(ctx, 'post_credit_note', cn);
  assert.equal(await stockOf(glass), 450);
  assert.equal(
    await val(ctx, 'SELECT amount_credited::float FROM erp.sales_invoices WHERE id = $1', [inv]),
    1770,
  );
});

test('cancelling a return takes the goods out of stock again', async () => {
  const cnId = await val(
    ctx,
    `SELECT id FROM erp.credit_notes WHERE invoice_id = $1 AND reason = 'sales_return'
    AND status = 'posted'`,
    [inv],
  );
  const balance0 = await balanceOf(customer);
  await call(ctx, 'cancel_credit_note', cnId, 'return was entered by mistake');
  assert.equal(await stockOf(handle), 90);
  assert.equal(await balanceOf(customer), balance0 + 1180);
  assert.equal(
    await val(ctx, 'SELECT amount_credited::float FROM erp.sales_invoices WHERE id = $1', [inv]),
    590,
  );
});

test('race: two returns of 4 on an invoice of 6 at the same time, only one wins', async () => {
  const inv6 = await doc(ctx, 'sales_invoices', saleHeader(), [line(handle, 6, 250)]);
  await call(ctx, 'post_sales_invoice', inv6);
  const stock = await stockOf(handle);

  const ret = () =>
    tx(db.api, ctx, async (c) => {
      const id = await insertDoc(
        c,
        'credit_notes',
        cnHeader(inv6, 'sales_return', { restock: true }),
        [line(handle, 4, 250)],
      );
      await c.query('SELECT pg_sleep(0.2)');
      return (await c.query('SELECT erp.post_credit_note($1) n', [id])).rows[0].n;
    });
  const results = await Promise.allSettled([ret(), ret()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'ERP04');
  assert.equal(await stockOf(handle), stock + 4);
});

// ----------------------------------------------------------------------------- quotations
test('quotation: issue -> frozen -> accept -> convert to draft invoice -> post', async () => {
  const qt = await doc(
    ctx,
    'quotations',
    { ...saleHeader(), valid_until: new Date(Date.now() + 15 * 86_400_000) },
    [
      line(glass, 24, 85, { size_unit: 'inch', width: 36, height: 48, pieces: 2 }),
      line(handle, 4, 260),
    ],
  );
  assert.equal(await call(ctx, 'issue_quotation', qt), `MAINQ${fy}/00001`);
  await blocked(
    q(ctx, `UPDATE erp.quotations SET customer_name = 'X' WHERE id = $1`, [qt]),
    'ERP03',
    'edit issued quote',
  );
  await blocked(
    q(ctx, 'UPDATE erp.quotation_lines SET rate = 1 WHERE quotation_id = $1', [qt]),
    'ERP03',
    'edit issued line',
  );

  await q(ctx, 'SELECT erp.set_quotation_response($1, true)', [qt]);
  const invId = await call(ctx, 'convert_quotation_to_invoice', qt);
  assert.equal(
    await call(ctx, 'convert_quotation_to_invoice', qt),
    invId,
    'converting twice gives the same invoice',
  );

  const d = await one(
    ctx,
    `SELECT i.status, i.grand_total::float g, count(l.*)::int n, max(l.width)::float w
    FROM erp.sales_invoices i JOIN erp.sales_invoice_lines l ON l.invoice_id = i.id WHERE i.id = $1
    GROUP BY i.id`,
    [invId],
  );
  assert.deepEqual(d, { status: 'draft', g: 3634.4, n: 2, w: 36 }); // (2040 + 1040) + 18%

  await call(ctx, 'post_sales_invoice', invId);
  assert.equal(
    await val(ctx, 'SELECT status FROM erp.quotations WHERE id = $1', [qt]),
    'converted',
  );
  await blocked(call(ctx, 'cancel_quotation', qt, 'x'), 'ERP02', 'cancel a converted quotation');
});

// ----------------------------------------------------------------------------- GST period lock
test('GST period lock: filed month is frozen; only owner/admin can unlock, with reason', async () => {
  const accountant = await addMember('CA Verma', '9800000002', 'accountant');
  const billing = await addMember('Cashier', '9800000003', 'billing');

  await blocked(
    q(accountant, `INSERT INTO erp.gst_period_locks (branch_id, period) VALUES ($1, $2)`, [
      branch,
      period,
    ]),
    '42501',
    'direct insert into locks',
  );
  await q(accountant, 'SELECT erp.lock_gst_period($1, $2, $3)', [branch, period, 'GSTR-1 filed']);

  const draft = await doc(ctx, 'sales_invoices', saleHeader(), [line(handle, 1, 250)]);
  await blocked(call(ctx, 'post_sales_invoice', draft), 'ERP05', 'post into a filed month');
  const unpaid = await val(
    ctx,
    `SELECT id FROM erp.sales_invoices WHERE status = 'posted'
    AND amount_paid = 0 AND amount_credited = 0 LIMIT 1`,
  );
  await blocked(
    call(ctx, 'cancel_sales_invoice', unpaid, 'x'),
    'ERP05',
    'cancel an invoice of a filed month',
  );
  const cn = await doc(ctx, 'credit_notes', cnHeader(inv, 'discount'), [
    line(glass, 0, 0, { taxable_value: 100, cgst_amount: 9, sgst_amount: 9 }),
  ]);
  await blocked(call(ctx, 'post_credit_note', cn), 'ERP05', 'credit note dated in a filed month');
  const pb = await doc(ctx, 'purchase_bills', purchaseHeader('GJ/103'), [
    line(lock, 1, 300, { interState: true }),
  ]);
  await blocked(call(ctx, 'post_purchase_bill', pb), 'ERP05', 'purchase dated in a filed month');

  await blocked(
    q(billing, 'SELECT erp.unlock_gst_period($1, $2, $3)', [branch, period, 'please']),
    '42501',
    'cashier unlocks',
  );
  await blocked(
    q(accountant, 'SELECT erp.unlock_gst_period($1, $2, $3)', [branch, period, 'oops']),
    '42501',
    'accountant unlocks',
  );
  await blocked(
    q(ctx, 'SELECT erp.unlock_gst_period($1, $2, $3)', [branch, period, '']),
    'ERP04',
    'unlock without reason',
  );
  await q(ctx, 'SELECT erp.unlock_gst_period($1, $2, $3)', [
    branch,
    period,
    'locked the wrong month',
  ]);

  assert.match(await call(ctx, 'post_sales_invoice', draft), /^MAIN\d{4}\/\d{5}$/);
  const ev = await one(
    ctx,
    `SELECT user_id, details FROM audit.events WHERE event_type = 'gst_period.unlocked'`,
  );
  assert.deepEqual(ev, { user_id: owner, details: { period, reason: 'locked the wrong month' } });
  const trail = await q(
    ctx,
    `SELECT action, user_id FROM audit.row_changes WHERE table_name = 'gst_period_locks' ORDER BY id`,
  );
  assert.deepEqual(trail, [
    { action: 'INSERT', user_id: accountant.userId },
    { action: 'DELETE', user_id: owner },
  ]);
});

test('race: an invoice cannot slip into a month while it is being locked', async () => {
  const draft = await doc(ctx, 'sales_invoices', saleHeader(), [line(handle, 1, 250)]);

  // Accountant locks the month; the lock transaction is still open (not committed).
  const locking = tx(db.api, ctx, async (c) => {
    await c.query('SELECT erp.lock_gst_period($1, $2)', [branch, period]);
    await c.query('SELECT pg_sleep(0.5)');
  });
  await new Promise((r) => setTimeout(r, 150));
  // Meanwhile a cashier posts. It must WAIT for the lock to commit, then be refused.
  // (Without the branch row lock it would not see the uncommitted lock and succeed.)
  const started = Date.now();
  const posting = call(ctx, 'post_sales_invoice', draft);
  const [lockRes, postRes] = await Promise.allSettled([locking, posting]);

  assert.equal(lockRes.status, 'fulfilled');
  assert.equal(postRes.status, 'rejected');
  assert.equal(postRes.reason.code, 'ERP05');
  assert.ok(Date.now() - started >= 250, 'posting waited for the lock transaction');
  await q(ctx, 'SELECT erp.unlock_gst_period($1, $2, $3)', [branch, period, 'test cleanup']);
});
