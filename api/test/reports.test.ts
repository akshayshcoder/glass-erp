import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, createShop, signUp, startTestApp } from './test-app.js';

/*
 * One realistic month of business, then every report checked against
 * hand-calculated numbers. All GST is 18%.
 *
 *   older months (for ageing): Delhi Fabricators 2,950 (100 days old), 1,180 (45 days)
 *                               purchase from Gujarat 4,720 (40 days)
 *   this month:
 *     A  B2B Delhi      glass 24 sqft @75 + 4 handles @250  = 2,800 + 252 + 252  = 3,304
 *     B  B2B Mumbai     3 handles @250 (IGST)               =   750 + 135        =   885
 *     C  walk-in Delhi  1 handle @300                       =   300 + 27 + 27    =   354
 *     D  walk-in to MH  1,500 sqft glass @90 (B2C large)    = 1,35,000 + 24,300  = 1,59,300
 *     E  walk-in to MH  2 handles @300 (B2C small, IGST)    =   600 + 108        =   708
 *     F  B2B Delhi      1 handle, then CANCELLED
 *     CN1 on A: 1 handle returned (restocked)                =   250 + 22.5 + 22.5 =  295
 *     CN2 on C: Rs 100 discount on the handle                =   100 + 9 + 9      =  118
 */

let t: Awaited<ReturnType<typeof startTestApp>>;
let shop: Client;
let branchId: string;
const p = { glass: '', handle: '' };
let delhi = '';
let mumbai = '';
let gujarat = '';

const ist = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const daysAgo = (n: number) => ist(new Date(Date.now() - n * 86_400_000));
const today = daysAgo(0);
const period = today.slice(0, 7);

async function bill(body: Record<string, unknown>) {
  const res = await shop.post('/v1/sales-invoices', { branchId, post: true, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

beforeAll(async () => {
  t = await startTestApp();
  shop = await createShop((await signUp(t.client(), 'Owner')).client);
  branchId = (await shop.get('/v1/branches')).body.items[0].id;

  p.glass = (
    await shop.post('/v1/products', {
      sku: 'GL-5',
      name: 'Clear Float Glass 5mm',
      kind: 'glass',
      hsnCode: '7005',
      gstRate: '18',
      unitCode: 'SQFT',
      measure: 'area',
      retailPrice: '90',
      wholesalePrice: '75',
    })
  ).body.id;
  p.handle = (
    await shop.post('/v1/products', {
      sku: 'HW-8',
      name: 'SS Handle 8 inch',
      kind: 'hardware',
      hsnCode: '8302',
      gstRate: '18',
      unitCode: 'PCS',
      retailPrice: '300',
      wholesalePrice: '250',
    })
  ).body.id;
  for (const [id, qty] of [
    [p.glass, '5000'],
    [p.handle, '500'],
  ] as const) {
    await shop.post('/v1/stock/adjustments', {
      branchId,
      productId: id,
      qtyChange: qty,
      reason: 'Opening',
      isOpening: true,
    });
  }
  delhi = (
    await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Delhi Fabricators',
      gstin: '07AAACB1234C1Z2',
    })
  ).body.id;
  mumbai = (
    await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Mumbai Interiors',
      gstin: '27AABCU9603R1ZM',
    })
  ).body.id;
  gujarat = (
    await shop.post('/v1/parties', {
      kind: 'supplier',
      name: 'Gujarat Glass Works',
      gstin: '24AAACG1234K1Z9',
    })
  ).body.id;

  // Older documents first (bill numbers must follow dates).
  await bill({
    partyId: delhi,
    invoiceDate: daysAgo(100),
    lines: [{ productId: p.handle, qty: 10 }],
  });
  await bill({
    partyId: delhi,
    invoiceDate: daysAgo(45),
    lines: [{ productId: p.handle, qty: 4 }],
  });
  const purchase = await shop.post('/v1/purchase-bills', {
    branchId,
    supplierId: gujarat,
    supplierInvoiceNo: 'GJ/1',
    supplierInvoiceDate: daysAgo(40),
    entryDate: daysAgo(40),
    post: true,
    lines: [{ productId: p.glass, qty: 100, rate: '40' }],
  });
  expect(purchase.status, JSON.stringify(purchase.body)).toBe(201);

  // This month.
  const a = await bill({
    partyId: delhi,
    lines: [
      { productId: p.glass, size: { unit: 'inch', width: 36, height: 48, pieces: 2 } },
      { productId: p.handle, qty: 4 },
    ],
  });
  await bill({ partyId: mumbai, lines: [{ productId: p.handle, qty: 3 }] });
  const c = await bill({ lines: [{ productId: p.handle, qty: 1 }] });
  await bill({ placeOfSupply: '27', lines: [{ productId: p.glass, qty: 1500 }] });
  await bill({ placeOfSupply: '27', lines: [{ productId: p.handle, qty: 2 }] });
  const f = await bill({ partyId: delhi, lines: [{ productId: p.handle, qty: 1 }] });
  expect(
    (await shop.post(`/v1/sales-invoices/${f.id}/cancel`, { reason: 'wrong customer' })).status,
  ).toBe(200);

  for (const note of [
    {
      invoiceId: a.id,
      reason: 'sales_return',
      restock: true,
      lines: [{ productId: p.handle, qty: 1 }],
    },
    { invoiceId: c.id, reason: 'discount', lines: [{ productId: p.handle, amount: '100' }] },
  ]) {
    const res = await shop.post('/v1/credit-notes', { ...note, post: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
});
afterAll(() => t?.close());

describe('GSTR-1', () => {
  let portal: any;

  beforeAll(async () => {
    const res = await shop.raw(
      'GET',
      `/v1/reports/gstr1?branchId=${branchId}&period=${period}&format=portal`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/GSTR1_07ABCDE1234F1Z5_\d{6}\.json/);
    portal = res.json();
  });

  it('return period and GSTIN', () => {
    const [y, m] = period.split('-');
    expect(portal).toMatchObject({ gstin: '07ABCDE1234F1Z5', fp: `${m}${y}` });
  });

  it('B2B: one entry per customer GSTIN; the cancelled bill is left out', () => {
    expect(portal.b2b.map((x: any) => x.ctin).sort()).toEqual([
      '07AAACB1234C1Z2',
      '27AABCU9603R1ZM',
    ]);
    const delhiInv = portal.b2b.find((x: any) => x.ctin === '07AAACB1234C1Z2').inv;
    expect(delhiInv).toHaveLength(1);
    expect(delhiInv[0]).toMatchObject({
      val: 3304,
      pos: '07',
      rchrg: 'N',
      inv_typ: 'R',
      itms: [
        { num: 1801, itm_det: { txval: 2800, rt: 18, iamt: 0, camt: 252, samt: 252, csamt: 0 } },
      ],
    });
    expect(
      portal.b2b.find((x: any) => x.ctin === '27AABCU9603R1ZM').inv[0].itms[0].itm_det,
    ).toEqual({
      txval: 750,
      rt: 18,
      iamt: 135,
      camt: 0,
      samt: 0,
      csamt: 0,
    });
  });

  it('B2CL: the inter-state walk-in sale above Rs 1 lakh', () => {
    expect(portal.b2cl).toEqual([
      {
        pos: '27',
        inv: [
          expect.objectContaining({
            val: 159300,
            itms: [{ num: 1801, itm_det: { txval: 135000, rt: 18, iamt: 24300, csamt: 0 } }],
          }),
        ],
      },
    ]);
  });

  it('B2CS: small B2C sales by state, net of their credit note', () => {
    expect(portal.b2cs).toEqual([
      {
        sply_ty: 'INTRA',
        pos: '07',
        typ: 'OE',
        rt: 18,
        txval: 200,
        iamt: 0,
        camt: 18,
        samt: 18,
        csamt: 0,
      },
      {
        sply_ty: 'INTER',
        pos: '27',
        typ: 'OE',
        rt: 18,
        txval: 600,
        iamt: 108,
        camt: 0,
        samt: 0,
        csamt: 0,
      },
    ]);
  });

  it('CDNR: the return from the registered customer', () => {
    expect(portal.cdnr).toHaveLength(1);
    expect(portal.cdnr[0].ctin).toBe('07AAACB1234C1Z2');
    expect(portal.cdnr[0].nt[0]).toMatchObject({
      ntty: 'C',
      val: 295,
      itms: [
        { num: 1801, itm_det: { txval: 250, rt: 18, iamt: 0, camt: 22.5, samt: 22.5, csamt: 0 } },
      ],
    });
    expect(portal.cdnur).toEqual([]);
  });

  it('HSN summary, B2B and B2C, net of credit notes', () => {
    const pick = (rows: any[]) =>
      rows.map((r) => ({
        hsn: r.hsn_sc,
        uqc: r.uqc,
        qty: r.qty,
        txval: r.txval,
        iamt: r.iamt,
        camt: r.camt,
      }));
    expect(pick(portal.hsn.hsn_b2b)).toEqual([
      { hsn: '7005', uqc: 'SQF', qty: 24, txval: 1800, iamt: 0, camt: 162 },
      { hsn: '8302', uqc: 'PCS', qty: 6, txval: 1500, iamt: 135, camt: 67.5 },
    ]);
    // Description is the product, not one bill's size ("... (36 x 48 in x 2 pcs)").
    expect(portal.hsn.hsn_b2b[0].desc).toBe('Clear Float Glass 5mm');
    expect(pick(portal.hsn.hsn_b2c)).toEqual([
      { hsn: '7005', uqc: 'SQF', qty: 1500, txval: 135000, iamt: 24300, camt: 0 },
      { hsn: '8302', uqc: 'PCS', qty: 3, txval: 800, iamt: 108, camt: 18 },
    ]);
  });

  it('document summary counts the cancelled bill', () => {
    const [invoices, notes] = portal.doc_issue.doc_det;
    expect(invoices).toMatchObject({
      doc_num: 1,
      docs: [expect.objectContaining({ totnum: 6, cancel: 1, net_issue: 5 })],
    });
    expect(notes).toMatchObject({
      doc_num: 5,
      docs: [expect.objectContaining({ totnum: 2, cancel: 0 })],
    });
  });

  it('Excel workbook has the offline-tool sheets', async () => {
    const res = await shop.raw(
      'GET',
      `/v1/reports/gstr1?branchId=${branchId}&period=${period}&format=xlsx`,
    );
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'summary',
      'b2b',
      'b2cl',
      'b2cs',
      'cdnr',
      'cdnur',
      'hsn(b2b)',
      'hsn(b2c)',
      'docs',
    ]);
    const b2b = wb.getWorksheet('b2b')!;
    expect(b2b.getRow(1).getCell(1).value).toBe('GSTIN/UIN of Recipient');
    expect(b2b.rowCount).toBe(3); // header + 2 invoices
    expect(b2b.getRow(2).getCell(6).value).toBe('07-Delhi');
  });

  it('an unregistered branch has no GSTR-1', async () => {
    const b2 = await shop.post('/v1/branches', { code: 'UR', name: 'Godown', stateCode: '07' });
    const res = await shop.get(`/v1/reports/gstr1?branchId=${b2.body.id}&period=${period}`);
    expect(res.status).toBe(422);
  });
});

describe('business reports', () => {
  it('receivables by age', async () => {
    const res = await shop.get('/v1/reports/receivables');
    const row = res.body.rows.find((r: any) => r.name === 'Delhi Fabricators');
    // 2,950 (100 days) + 1,180 (45 days) + (3,304 - 295 returned) this month
    expect(row).toMatchObject({
      bills: 3,
      d0_30: '3009.00',
      d31_60: '1180.00',
      d61_90: '0.00',
      d90: '2950.00',
      total: '7139.00',
    });
    const walkIn = res.body.rows.find((r: any) => r.name === 'Walk-in: Cash Sale');
    expect(walkIn.total).toBe('160244.00'); // 236 + 1,59,300 + 708
    expect(res.body.totals.total).toBe('168268.00'); // + Mumbai 885
  });

  it('payables by age', async () => {
    const res = await shop.get('/v1/reports/payables');
    expect(res.body.rows).toEqual([
      expect.objectContaining({ name: 'Gujarat Glass Works', d31_60: '4720.00', total: '4720.00' }),
    ]);
  });

  it('sales by day: bills and credit notes', async () => {
    const res = await shop.get(`/v1/reports/sales?from=${today}&to=${today}&groupBy=day`);
    expect(res.body.rows).toEqual([
      {
        period: today,
        invoices: 5,
        taxable: '139450.00',
        gst: '25101.00',
        total: '164551.00',
        credit_notes: '413.00',
        net: '164138.00',
      },
    ]);
  });

  it('sales by product with estimated margin (net of returns)', async () => {
    const res = await shop.get(`/v1/reports/sales?from=${today}&to=${today}&groupBy=product`);
    expect(res.body.rows.find((r: any) => r.sku === 'GL-5')).toMatchObject({
      qty: '1524.000',
      sales: '136800.00',
      cost: '60960.00',
      margin: '75840.00',
    });
    expect(res.body.rows.find((r: any) => r.sku === 'HW-8')).toMatchObject({
      qty: '9.000',
      sales: '2300.00',
    });
  });

  it('stock value at last purchase price', async () => {
    const res = await shop.get('/v1/reports/stock-value');
    // 5,000 + 100 bought - 24 - 1,500 sold = 3,576 sq ft x Rs 40
    expect(res.body.rows.find((r: any) => r.sku === 'GL-5')).toMatchObject({
      qty: '3576.000',
      value: '143040.00',
    });
  });

  it('purchase register, and Excel export of any report', async () => {
    const res = await shop.get(`/v1/reports/purchases?from=${daysAgo(60)}&to=${today}`);
    expect(res.body.rows).toEqual([
      expect.objectContaining({
        supplier_gstin: '24AAACG1234K1Z9',
        igst_amount: '720.00',
        grand_total: '4720.00',
        itc: 'Yes',
      }),
    ]);
    const xlsx = await shop.raw(
      'GET',
      `/v1/reports/purchases?from=${daysAgo(60)}&to=${today}&format=xlsx`,
    );
    expect(xlsx.headers['content-disposition']).toContain('Purchase_register');
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK'); // .xlsx is a zip
  });

  it('a cashier cannot see reports', async () => {
    const cashier = await signUp(t.client(), 'Cashier');
    await shop.post('/v1/members', { login: cashier.phone, role: 'billing' });
    const res = await cashier.client.inShop(shop.tenantId!).get('/v1/reports/receivables');
    expect(res.status).toBe(403);
  });
});
