import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, createShop, signUp, startTestApp } from './test-app.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let shop: Client; // owner
let branchId: string;
const p: Record<'glass' | 'handle' | 'section' | 'lock', string> = {
  glass: '',
  handle: '',
  section: '',
  lock: '',
};
let customerDl: string;
let customerMh: string;
let supplierGj: string;

async function member(role: string, extra: Record<string, unknown> = {}) {
  const person = await signUp(t.client(), `A ${role}`);
  const res = await shop.post('/v1/members', { login: person.phone, role, ...extra });
  expect(res.status).toBe(201);
  return person.client.inShop(shop.tenantId!);
}
const stockOf = async (id: string) =>
  (await shop.get(`/v1/stock?branchId=${branchId}`)).body.items.find(
    (s: { productId: string }) => s.productId === id,
  )?.qty;

beforeAll(async () => {
  t = await startTestApp();
  shop = await createShop((await signUp(t.client(), 'Owner')).client);
  branchId = (await shop.get('/v1/branches')).body.items[0].id;

  const products = [
    [
      'glass',
      {
        sku: 'GL-CLR-5',
        name: 'Clear Float Glass 5mm',
        kind: 'glass',
        hsnCode: '7005',
        unitCode: 'SQFT',
        measure: 'area',
        retailPrice: '90',
        wholesalePrice: '75',
      },
      '500',
    ],
    [
      'handle',
      {
        sku: 'HW-HDL-8',
        name: 'SS Handle 8 inch',
        kind: 'hardware',
        hsnCode: '8302',
        unitCode: 'PCS',
        retailPrice: '300',
        wholesalePrice: '250',
      },
      '100',
    ],
    [
      'section',
      {
        sku: 'AL-SEC-1',
        name: 'Aluminium Section 1in',
        kind: 'aluminium',
        hsnCode: '7604',
        unitCode: 'RFT',
        measure: 'length',
        retailPrice: '140',
        wholesalePrice: '120',
      },
      '400',
    ],
    [
      'lock',
      {
        sku: 'HW-LOCK-1',
        name: 'Door Lock',
        kind: 'hardware',
        hsnCode: '8301',
        unitCode: 'PCS',
        retailPrice: '500',
        wholesalePrice: '450',
      },
      '10',
    ],
  ] as const;
  for (const [key, product, opening] of products) {
    const res = await shop.post('/v1/products', { ...product, gstRate: '18' });
    p[key] = res.body.id;
    await shop.post('/v1/stock/adjustments', {
      branchId,
      productId: res.body.id,
      qtyChange: opening,
      reason: 'Opening stock',
      isOpening: true,
    });
  }
  customerDl = (
    await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Delhi Fabricators',
      gstin: '07AAACB1234C1Z2',
    })
  ).body.id;
  customerMh = (
    await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Mumbai Interiors',
      gstin: '27AABCU9603R1ZM',
    })
  ).body.id;
  supplierGj = (
    await shop.post('/v1/parties', {
      kind: 'supplier',
      name: 'Gujarat Glass Works',
      gstin: '24AAACG1234K1Z9',
    })
  ).body.id;
});
afterAll(() => t?.close());

// =============================================================================
describe('sales invoices', () => {
  let inv1: string;

  it('B2B, same state: server prices the lines, converts glass size to sq ft, splits CGST/SGST', async () => {
    const res = await shop.post('/v1/sales-invoices', {
      branchId,
      partyId: customerDl,
      post: true,
      lines: [
        { productId: p.glass, size: { unit: 'inch', width: 36, height: 48, pieces: 2 } },
        { productId: p.handle, qty: 4 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'posted',
      supplyType: 'b2b',
      customerName: 'Delhi Fabricators',
      customerGstin: '07AAACB1234C1Z2',
      sellerGstin: '07ABCDE1234F1Z5',
      taxableValue: '2800.00',
      cgstAmount: '252.00',
      sgstAmount: '252.00',
      igstAmount: '0.00',
      grandTotal: '3304.00',
      balanceDue: '3304.00',
    });
    expect(res.body.invoiceNo).toMatch(/^MAIN\d{4}\/00001$/);
    expect(res.body.lines[0]).toMatchObject({
      description: 'Clear Float Glass 5mm (36 x 48 in x 2 pcs)',
      hsnCode: '7005',
      qty: '24.000',
      rate: '75.0000', // B2B -> wholesale price
      width: '36.000',
      pieces: 2,
    });
    expect(await stockOf(p.glass)).toBe('476.000');
    inv1 = res.body.id;
  });

  it('B2B, other state: IGST only; aluminium length -> running feet', async () => {
    const res = await shop.post('/v1/sales-invoices', {
      branchId,
      partyId: customerMh,
      lines: [{ productId: p.section, size: { unit: 'ft', length: 16, pieces: 5 } }],
    });
    expect(res.body).toMatchObject({
      status: 'draft',
      placeOfSupply: '27',
      taxableValue: '9600.00',
      igstAmount: '1728.00',
      cgstAmount: '0.00',
      grandTotal: '11328.00',
    });
    expect(res.body.lines[0].qty).toBe('80.000');
  });

  it('walk-in counter sale: billed and paid in one step', async () => {
    const res = await shop.post('/v1/sales-invoices', {
      branchId,
      customerName: 'Ramesh',
      customerPhone: '9811100000',
      post: true,
      payment: { mode: 'cash', amount: '354' },
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      supplyType: 'b2c',
      customerName: 'Ramesh',
      grandTotal: '354.00', // retail 300 + 18%
      amountPaid: '354.00',
      balanceDue: '0.00',
    });
    const receipts = await shop.get('/v1/receipts');
    expect(receipts.body.items[0]).toMatchObject({
      amount: '354.00',
      mode: 'cash',
      status: 'posted',
    });
  });

  it('odd sizes round correctly: 25 x 31 in = 5.382 sq ft, total rounded to the rupee', async () => {
    const res = await shop.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: p.glass, size: { unit: 'inch', width: 25, height: 31, pieces: 1 } }],
    });
    expect(res.body.lines[0].qty).toBe('5.382');
    expect(res.body).toMatchObject({
      taxableValue: '484.38',
      cgstAmount: '43.59',
      sgstAmount: '43.59',
      roundOff: '0.44',
      grandTotal: '572.00',
    });
  });

  it('all-or-nothing: a sale that would oversell creates nothing at all', async () => {
    const before = (await shop.get('/v1/sales-invoices?pageSize=200')).body.items.length;
    const res = await shop.post('/v1/sales-invoices', {
      branchId,
      post: true,
      payment: { mode: 'cash', amount: '6490' },
      lines: [{ productId: p.lock, qty: 11 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
    expect((await shop.get('/v1/sales-invoices?pageSize=200')).body.items.length).toBe(before);
    expect(await stockOf(p.lock)).toBe('10.000');
  });

  it('retries with the same Idempotency-Key return the same invoice, even in parallel', async () => {
    const body = { branchId, lines: [{ productId: p.handle, qty: 1 }] };
    const first = await shop.post('/v1/sales-invoices', body, {
      'idempotency-key': 'key-sequential-1',
    });
    const again = await shop.post('/v1/sales-invoices', body, {
      'idempotency-key': 'key-sequential-1',
    });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);

    const parallel = await Promise.all([
      shop.post('/v1/sales-invoices', body, { 'idempotency-key': 'key-parallel-2' }),
      shop.post('/v1/sales-invoices', body, { 'idempotency-key': 'key-parallel-2' }),
    ]);
    expect(parallel.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(parallel[0]!.body.id).toBe(parallel[1]!.body.id);
  });

  it('drafts: edit with version, then frozen once posted; only drafts can be deleted', async () => {
    const draft = await shop.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    const id = draft.body.id;
    const edited = await shop.put(`/v1/sales-invoices/${id}`, {
      branchId,
      version: 1,
      lines: [{ productId: p.handle, qty: 2 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ grandTotal: '708.00', version: 2 });
    expect(
      (
        await shop.put(`/v1/sales-invoices/${id}`, {
          branchId,
          version: 1,
          lines: [{ productId: p.handle, qty: 3 }],
        })
      ).body.code,
    ).toBe('VERSION_CONFLICT');

    const posted = await shop.post(`/v1/sales-invoices/${id}/post`);
    expect(posted.body.status).toBe('posted');
    const late = await shop.put(`/v1/sales-invoices/${id}`, {
      branchId,
      version: posted.body.version,
      lines: [{ productId: p.handle, qty: 9 }],
    });
    expect(late.body.code).toBe('RECORD_LOCKED');
    expect((await shop.del(`/v1/sales-invoices/${id}`)).body.code).toBe('RECORD_LOCKED');

    const another = await shop.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect((await shop.del(`/v1/sales-invoices/${another.body.id}`)).status).toBe(204);
    expect((await shop.get(`/v1/sales-invoices/${another.body.id}`)).status).toBe(404);
  });

  it('input validation', async () => {
    const noQty = await shop.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: p.handle }],
    });
    expect(noQty.status).toBe(400);
    const sizeOnPieces = await shop.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: p.handle, size: { unit: 'inch', width: 1, height: 1 } }],
    });
    expect(sizeOnPieces.body.code).toBe('BUSINESS_RULE');
    const supplierAsCustomer = await shop.post('/v1/sales-invoices', {
      branchId,
      partyId: supplierGj,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(supplierAsCustomer.status).toBe(422);
    const unknownProduct = await shop.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: '00000000-0000-4000-8000-000000000000', qty: 1 }],
    });
    expect(unknownProduct.body.code).toBe('INVALID_REFERENCE');
    const payWithoutPost = await shop.post('/v1/sales-invoices', {
      branchId,
      payment: { mode: 'cash', amount: 1 },
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(payWithoutPost.status).toBe(400);
  });

  it('PDF tax invoice', async () => {
    const res = await shop.raw('GET', `/v1/sales-invoices/${inv1}/pdf`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(res.rawPayload.length).toBeGreaterThan(2000);
  });

  // -----------------------------------------------------------------------------
  describe('receipts', () => {
    it('partial payment, over-payment refused, cancel needs a manager', async () => {
      const receipt = await shop.post('/v1/receipts', {
        branchId,
        partyId: customerDl,
        mode: 'upi',
        amount: '2000',
        referenceNo: 'UTR1',
        allocations: [{ invoiceId: inv1, amount: '2000' }],
        post: true,
      });
      expect(receipt.status).toBe(201);
      expect(receipt.body.receiptNo).toMatch(/^MAINR\d{4}\/\d{5}$/);
      expect((await shop.get(`/v1/sales-invoices/${inv1}`)).body.balanceDue).toBe('1304.00');

      const over = await shop.post('/v1/receipts', {
        branchId,
        partyId: customerDl,
        mode: 'cash',
        amount: '2000',
        allocations: [{ invoiceId: inv1, amount: '2000' }],
        post: true,
      });
      expect(over.body.code).toBe('BUSINESS_RULE');

      const cashier = await member('billing');
      expect(
        (await cashier.post(`/v1/receipts/${receipt.body.id}/cancel`, { reason: 'bounced' }))
          .status,
      ).toBe(403);
      const cancelled = await shop.post(`/v1/receipts/${receipt.body.id}/cancel`, {
        reason: 'cheque bounced',
      });
      expect(cancelled.body.status).toBe('cancelled');
      expect((await shop.get(`/v1/sales-invoices/${inv1}`)).body.balanceDue).toBe('3304.00');
    });

    it('advance receipt goes to wallet, auto-knockoff settles invoices in FIFO order, and billing settles from advance', async () => {
      const customerAdv = (
        await shop.post('/v1/parties', {
          kind: 'customer',
          name: 'Advance Wallet Customer',
          gstin: '07AAACB9999C1Z5',
        })
      ).body.id;

      // 1. Advance receipt of 5000 with no allocations
      const advReceipt = await shop.post('/v1/receipts', {
        branchId,
        partyId: customerAdv,
        mode: 'bank_transfer',
        amount: '5000.00',
        referenceNo: 'ADV-UTR-999',
        post: true,
      });
      expect(advReceipt.status).toBe(201);

      // Check customer wallet
      const walletBefore = await shop.get(`/v1/parties/${customerAdv}/wallet`);
      expect(walletBefore.status).toBe(200);
      expect(walletBefore.body.walletBalance).toBe('5000.00');
      expect(walletBefore.body.receipts.length).toBeGreaterThanOrEqual(1);

      // 2. Create two invoices for customerAdv
      // wholesale price of handle is 250. 4 * 250 = 1000 + 18% GST = 1180.00
      const invA = (
        await shop.post('/v1/sales-invoices', {
          branchId,
          partyId: customerAdv,
          post: true,
          lines: [{ productId: p.handle, qty: 4 }],
        })
      ).body;
      expect(invA.grandTotal).toBe('1180.00');
      expect(invA.balanceDue).toBe('1180.00');

      // 8 * 250 = 2000 + 18% GST = 2360.00
      const invB = (
        await shop.post('/v1/sales-invoices', {
          branchId,
          partyId: customerAdv,
          post: true,
          lines: [{ productId: p.handle, qty: 8 }],
        })
      ).body;
      expect(invB.grandTotal).toBe('2360.00');
      expect(invB.balanceDue).toBe('2360.00');

      // 3. FIFO Auto-Knockoff
      // Total unpaid on A + B = 1180 + 2360 = 3540.00
      // Available advance = 5000.00
      // Expected after knockoff: A paid (1180), B paid (2360), remaining advance in wallet = 5000 - 3540 = 1460.00
      const knockoff = await shop.post(`/v1/parties/${customerAdv}/auto-knockoff`, {});
      expect(knockoff.status).toBe(200);
      expect(Number(knockoff.body.totalSettled)).toBe(3540);
      expect(knockoff.body.invoicesCount).toBeGreaterThanOrEqual(2);

      // Verify both invoices are now fully settled
      const checkA = await shop.get(`/v1/sales-invoices/${invA.id}`);
      expect(checkA.body.balanceDue).toBe('0.00');
      expect(checkA.body.amountPaid).toBe('1180.00');

      const checkB = await shop.get(`/v1/sales-invoices/${invB.id}`);
      expect(checkB.body.balanceDue).toBe('0.00');
      expect(checkB.body.amountPaid).toBe('2360.00');

      // Verify remaining wallet advance
      const walletMid = await shop.get(`/v1/parties/${customerAdv}/wallet`);
      expect(walletMid.body.walletBalance).toBe('1460.00');

      // 4. Create Invoice C with useAdvance: true
      // 4 handles = 1180.00 grand total
      // Since wallet has 1460.00, Invoice C should be 100% covered from advance!
      const invC = (
        await shop.post('/v1/sales-invoices', {
          branchId,
          partyId: customerAdv,
          post: true,
          useAdvance: true,
          lines: [{ productId: p.handle, qty: 4 }],
        })
      ).body;
      expect(invC.balanceDue).toBe('0.00');
      expect(invC.amountPaid).toBe('1180.00');

      // Remaining wallet advance should now be 1460 - 1180 = 280.00
      const walletAfter = await shop.get(`/v1/parties/${customerAdv}/wallet`);
      expect(walletAfter.body.walletBalance).toBe('280.00');
    });
  });

  // -----------------------------------------------------------------------------
  describe('credit notes', () => {
    it('sales return with restock: stock back, invoice credited', async () => {
      const res = await shop.post('/v1/credit-notes', {
        invoiceId: inv1,
        reason: 'sales_return',
        restock: true,
        post: true,
        lines: [{ productId: p.handle, qty: 2 }],
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: 'posted',
        grandTotal: '590.00',
        customerGstin: '07AAACB1234C1Z2',
      });
      expect(res.body.noteNo).toMatch(/^MAINCN\d{4}\/00001$/);
      expect(res.body.lines[0]).toMatchObject({ rate: '250.0000', qty: '2.000' }); // invoice rate
      const inv = (await shop.get(`/v1/sales-invoices/${inv1}`)).body;
      expect(inv).toMatchObject({ amountCredited: '590.00', balanceDue: '2714.00' });
    });

    it('value-only discount note; returning more than was sold is refused', async () => {
      const discount = await shop.post('/v1/credit-notes', {
        invoiceId: inv1,
        reason: 'discount',
        post: true,
        lines: [{ productId: p.glass, amount: '100' }],
      });
      expect(discount.body).toMatchObject({ grandTotal: '118.00', restock: false });

      const tooMany = await shop.post('/v1/credit-notes', {
        invoiceId: inv1,
        reason: 'sales_return',
        post: true,
        lines: [{ productId: p.handle, qty: 3 }], // 2 already returned of 4
      });
      expect(tooMany.body.code).toBe('BUSINESS_RULE');

      const badRestock = await shop.post('/v1/credit-notes', {
        invoiceId: inv1,
        reason: 'discount',
        restock: true,
        lines: [{ productId: p.glass, amount: '1' }],
      });
      expect(badRestock.status).toBe(400);
    });
  });
});

// =============================================================================
describe('purchases', () => {
  let billId: string;

  it('supplier bill from another state: IGST, stock in, last purchase price', async () => {
    const res = await shop.post('/v1/purchase-bills', {
      branchId,
      supplierId: supplierGj,
      supplierInvoiceNo: 'GJ/501',
      supplierInvoiceDate: (await shop.get(`/v1/sales-invoices?pageSize=1`)).body.items[0]
        .invoiceDate,
      post: true,
      lines: [
        { productId: p.glass, qty: 1000, rate: '40' },
        { productId: p.handle, qty: 50, rate: '150' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'posted',
      igstAmount: '8550.00',
      cgstAmount: '0.00',
      grandTotal: '56050.00',
    });
    expect(res.body.docNo).toMatch(/^MAINP\d{4}\/00001$/);
    expect((await shop.get(`/v1/products/${p.glass}`)).body.purchasePrice).toBe('40.0000');
    billId = res.body.id;
  });

  it('the same supplier bill number cannot be entered twice', async () => {
    const dup = await shop.post('/v1/purchase-bills', {
      branchId,
      supplierId: supplierGj,
      supplierInvoiceNo: 'gj/501',
      supplierInvoiceDate: '2026-04-01',
      lines: [{ productId: p.glass, qty: 1 }],
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
  });

  it('supplier payment reduces what we owe', async () => {
    const pay = await shop.post('/v1/supplier-payments', {
      branchId,
      supplierId: supplierGj,
      mode: 'bank_transfer',
      amount: '50000',
      referenceNo: 'NEFT9',
      allocations: [{ billId, amount: '50000' }],
      post: true,
    });
    expect(pay.status).toBe(201);
    expect(pay.body.paymentNo).toMatch(/^MAINV\d{4}\/00001$/);
    expect((await shop.get(`/v1/parties/${supplierGj}`)).body.balance).toBe('-6050.00');
  });
});

// =============================================================================
describe('quotations', () => {
  it('issue -> frozen -> accept -> convert to a draft invoice -> post', async () => {
    const q = await shop.post('/v1/quotations', {
      branchId,
      partyId: customerDl,
      validUntil: '2099-12-31',
      terms: 'Fitting extra. 50% advance.',
      lines: [
        { productId: p.glass, size: { unit: 'inch', width: 48, height: 60, pieces: 1 } },
        { productId: p.handle, qty: 2 },
      ],
    });
    expect(q.status).toBe(201);
    expect(q.body.grandTotal).toBe('2360.00');

    const issued = await shop.post(`/v1/quotations/${q.body.id}/issue`);
    expect(issued.body.quoteNo).toMatch(/^MAINQ\d{4}\/00001$/);
    const edit = await shop.put(`/v1/quotations/${q.body.id}`, {
      branchId,
      version: issued.body.version,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(edit.body.code).toBe('RECORD_LOCKED');

    await shop.post(`/v1/quotations/${q.body.id}/accept`);
    const invoice = await shop.post(`/v1/quotations/${q.body.id}/convert`);
    expect(invoice.body).toMatchObject({ status: 'draft', grandTotal: '2360.00' });
    expect((await shop.post(`/v1/quotations/${q.body.id}/convert`)).body.id).toBe(invoice.body.id);

    expect((await shop.post(`/v1/sales-invoices/${invoice.body.id}/post`)).body.status).toBe(
      'posted',
    );
    expect((await shop.get(`/v1/quotations/${q.body.id}`)).body.status).toBe('converted');
  });
});

// =============================================================================
describe('access & GST period lock', () => {
  it('a member limited to one branch cannot bill from another', async () => {
    const b2 = await shop.post('/v1/branches', {
      code: 'B2',
      name: 'Second Shop',
      stateCode: '07',
    });
    const cashier = await member('billing', { branchIds: [b2.body.id] });
    const here = await cashier.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(here.status).toBe(403);
    const there = await cashier.post('/v1/sales-invoices', {
      branchId: b2.body.id,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(there.status).toBe(201);
  });

  it('a filed month is locked for posting; owner can unlock with a reason', async () => {
    const accountant = await member('accountant');
    const period = (
      await shop.get('/v1/sales-invoices?pageSize=1')
    ).body.items[0].invoiceDate.slice(0, 7);
    expect(
      (await accountant.post('/v1/gst-periods/lock', { branchId, period, note: 'GSTR-1 filed' }))
        .status,
    ).toBe(204);
    expect((await shop.get('/v1/gst-periods')).body.items).toMatchObject([
      { period, note: 'GSTR-1 filed' },
    ]);

    const blocked = await shop.post('/v1/sales-invoices', {
      branchId,
      post: true,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(blocked.body.code).toBe('GST_PERIOD_LOCKED');
    const draft = await shop.post('/v1/sales-invoices', {
      branchId,
      lines: [{ productId: p.handle, qty: 1 }],
    });
    expect(draft.status).toBe(201); // drafts are fine

    expect(
      (await accountant.post('/v1/gst-periods/unlock', { branchId, period, reason: 'oops' }))
        .status,
    ).toBe(403);
    expect(
      (await shop.post('/v1/gst-periods/unlock', { branchId, period, reason: 'locked too early' }))
        .status,
    ).toBe(204);
    expect((await shop.post(`/v1/sales-invoices/${draft.body.id}/post`)).body.status).toBe(
      'posted',
    );
  });
});

// =============================================================================
describe('concurrency through the API', () => {
  it('8 cashiers sell 2 of the last 10 locks at once: 5 sales, stock 0, numbers gap-free', async () => {
    const sell = () =>
      shop.post('/v1/sales-invoices', {
        branchId,
        post: true,
        payment: { mode: 'cash', amount: '1180' },
        lines: [{ productId: p.lock, qty: 2 }],
      });
    const results = await Promise.all(Array.from({ length: 8 }, sell));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    expect(results.filter((r) => r.body.code === 'INSUFFICIENT_STOCK')).toHaveLength(3);
    expect(await stockOf(p.lock)).toBe('0.000');

    const all = (await shop.get(`/v1/sales-invoices?branchId=${branchId}&pageSize=200`)).body.items;
    const numbers = all
      .filter((i: { invoiceNo: string | null }) => i.invoiceNo)
      .map((i: { invoiceNo: string }) => Number(i.invoiceNo.split('/')[1]))
      .sort((a: number, b: number) => a - b);
    expect(numbers).toEqual(numbers.map((_: number, i: number) => i + 1));
  });
});

// =============================================================================
describe('billing screen helpers', () => {
  it('preview prices a bill without saving it', async () => {
    const before = (await shop.get('/v1/sales-invoices?pageSize=200')).body.items.length;
    const res = await shop.post('/v1/sales-invoices/preview', {
      branchId,
      partyId: customerDl,
      lines: [{ productId: p.glass, size: { unit: 'inch', width: 36, height: 48, pieces: 2 } }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      supplyType: 'b2b',
      grandTotal: '2124.00',
      cgstAmount: '162.00',
    });
    expect(res.body.lines[0]).toMatchObject({
      lineNo: 1,
      lineTotal: '2124.00',
      qty: '24.000',
      description: 'Clear Float Glass 5mm (36 x 48 in x 2 pcs)',
    });
    expect((await shop.get('/v1/sales-invoices?pageSize=200')).body.items.length).toBe(before);
  });

  it('dashboard summarises sales, dues and recent invoices', async () => {
    const res = await shop.get('/v1/dashboard');
    expect(res.status).toBe(200);
    expect(Number(res.body.today.sales)).toBeGreaterThan(0);
    expect(res.body.today.invoices).toBeGreaterThan(0);
    expect(Number(res.body.receivable)).toBeGreaterThan(0);
    expect(res.body.recentInvoices.length).toBeGreaterThan(0);
  });
});

// =============================================================================
describe('step 4b helpers: previews, unpaid lists, PDFs', () => {
  it('purchase preview prices a supplier bill (IGST) without saving', async () => {
    const res = await shop.post('/v1/purchase-bills/preview', {
      branchId,
      supplierId: supplierGj,
      lines: [{ productId: p.glass, qty: 100, rate: '40' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ igstAmount: '720.00', grandTotal: '4720.00' });
    expect(res.body.lines[0]).toMatchObject({ lineNo: 1, lineTotal: '4720.00' });
  });

  it('credit note preview copies tax from the invoice', async () => {
    const invoice = (
      await shop.get(`/v1/sales-invoices?partyId=${customerDl}&status=posted&pageSize=200`)
    ).body.items.at(-1);
    const res = await shop.post('/v1/credit-notes/preview', {
      invoiceId: invoice.id,
      reason: 'discount',
      lines: [{ productId: p.glass, amount: '50' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cgstAmount: '4.50', sgstAmount: '4.50', grandTotal: '59.00' });
  });

  it('unpaid filters list only documents with money outstanding', async () => {
    const invoices = (await shop.get('/v1/sales-invoices?unpaid=true&pageSize=200')).body.items;
    expect(invoices.length).toBeGreaterThan(0);
    expect(
      invoices.every(
        (i: { status: string; balanceDue: string }) =>
          i.status === 'posted' && Number(i.balanceDue) > 0,
      ),
    ).toBe(true);
    const bills = (await shop.get('/v1/purchase-bills?unpaid=true')).body.items;
    expect(bills.map((b: { balanceDue: string }) => b.balanceDue)).toEqual(['6050.00']);
  });

  it('quotation and credit note PDFs', async () => {
    const quote = (await shop.get('/v1/quotations')).body.items[0];
    const q = await shop.raw('GET', `/v1/quotations/${quote.id}/pdf`);
    expect(q.headers['content-type']).toBe('application/pdf');
    expect(q.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const note = (await shop.get('/v1/credit-notes?status=posted')).body.items[0];
    const n = await shop.raw('GET', `/v1/credit-notes/${note.id}/pdf`);
    expect(n.statusCode).toBe(200);
    expect(n.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
