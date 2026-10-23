import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, createShop, signUp, startTestApp } from './test-app.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let shop: Client;
let branchId: string;

beforeAll(async () => {
  t = await startTestApp();
  const owner = await signUp(t.client(), 'Owner');
  shop = await createShop(owner.client);
  branchId = (await shop.get('/v1/branches')).body.items[0].id;
});
afterAll(() => t?.close());

const glass = {
  sku: 'GL-CLR-5',
  name: 'Clear Float Glass 5mm',
  kind: 'glass',
  hsnCode: '7005',
  gstRate: '18',
  unitCode: 'sqft',
  measure: 'area',
  thicknessMm: '5',
  retailPrice: 90,
  wholesalePrice: '75.50',
};

describe('products', () => {
  let id: string;

  it('creates a product; money comes back as exact decimal strings', async () => {
    const res = await shop.post('/v1/products', glass);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      sku: 'GL-CLR-5',
      unitCode: 'SQFT',
      gstRate: '18.00',
      retailPrice: '90.0000',
      wholesalePrice: '75.5000',
      trackInventory: true,
      version: 1,
    });
    id = res.body.id;
  });

  it('rejects bad input with field errors', async () => {
    const res = await shop.post('/v1/products', {
      ...glass,
      sku: 'X',
      hsnCode: '70',
      gstRate: '18.123',
    });
    expect(res.status).toBe(400);
    expect(res.body.detail.map((d: { field: string }) => d.field).sort()).toEqual([
      'gstRate',
      'hsnCode',
    ]);
  });

  it('rejects an unknown unit and a duplicate SKU', async () => {
    expect(
      (await shop.post('/v1/products', { ...glass, sku: 'X1', unitCode: 'BUCKET' })).body.code,
    ).toBe('INVALID_REFERENCE');
    expect((await shop.post('/v1/products', glass)).body.code).toBe('DUPLICATE');
  });

  it('optimistic locking: a stale edit is rejected, not silently overwritten', async () => {
    expect((await shop.patch(`/v1/products/${id}`, { version: 1, retailPrice: '95' })).status).toBe(
      200,
    );
    const stale = await shop.patch(`/v1/products/${id}`, { version: 1, retailPrice: '99' });
    expect(stale.status).toBe(409);
    expect((await shop.get(`/v1/products/${id}`)).body.retailPrice).toBe('95.0000');
  });

  it('search and paging', async () => {
    for (let i = 1; i <= 5; i++) {
      await shop.post('/v1/products', {
        sku: `HW-${i}`,
        name: `Handle ${i}`,
        kind: 'hardware',
        hsnCode: '8302',
        gstRate: '18',
        unitCode: 'PCS',
      });
    }
    const page1 = await shop.get('/v1/products?search=handle&pageSize=3');
    expect(page1.body.items.map((p: { name: string }) => p.name)).toEqual([
      'Handle 1',
      'Handle 2',
      'Handle 3',
    ]);
    const page2 = await shop.get(
      `/v1/products?search=handle&pageSize=3&pageToken=${page1.body.nextPageToken}`,
    );
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.nextPageToken).toBeNull();

    // LIKE wildcards in the search box are literal.
    expect((await shop.get('/v1/products?search=%25')).body.items).toHaveLength(0);
  });

  it('retired products disappear from the default list', async () => {
    const p = (await shop.get('/v1/products?search=Handle%205')).body.items[0];
    await shop.patch(`/v1/products/${p.id}`, { version: p.version, isActive: false });
    expect((await shop.get('/v1/products?search=Handle%205')).body.items).toHaveLength(0);
    expect(
      (await shop.get('/v1/products?search=Handle%205&status=inactive')).body.items,
    ).toHaveLength(1);
  });
});

describe('parties', () => {
  let customerId: string;

  it('fills the state from the GSTIN', async () => {
    const res = await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Delhi Fabricators',
      gstin: '07aaacb1234c1z2',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ gstin: '07AAACB1234C1Z2', stateCode: '07', balance: '0.00' });
    customerId = res.body.id;
  });

  it('classifies customers: derived default, explicit type, filter, and bad type refused', async () => {
    const detail = await shop.get(`/v1/parties/${customerId}`);
    expect(detail.body.customerType).toBe('b2b'); // has a GSTIN, no type given

    const walkIn = await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Counter Ramesh',
      customerType: 'walk_in',
    });
    expect(walkIn.status).toBe(201);
    expect(walkIn.body.customerType).toBe('walk_in');
    const plain = await shop.post('/v1/parties', { kind: 'customer', name: 'Home Buyer' });
    expect(plain.body.customerType).toBe('b2c');

    const franchise = await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Pune Franchise',
      customerType: 'franchise',
    });
    expect(franchise.status).toBe(201);

    const list = await shop.get('/v1/parties?customerType=walk_in');
    expect(list.body.items.map((p: { name: string }) => p.name)).toEqual(['Counter Ramesh']);

    const patched = await shop.patch(`/v1/parties/${walkIn.body.id}`, {
      version: walkIn.body.version,
      customerType: 'b2b',
    });
    expect(patched.body.customerType).toBe('b2b');

    const bad = await shop.post('/v1/parties', { kind: 'customer', name: 'Z', customerType: 'vip' });
    expect(bad.status).toBe(400);
  });

  it('rejects a GSTIN from another state and a duplicate GSTIN', async () => {
    const mismatch = await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'X',
      gstin: '27AABCU9603R1ZM',
      stateCode: '07',
    });
    expect(mismatch.status).toBe(400);
    const dup = await shop.post('/v1/parties', {
      kind: 'customer',
      name: 'Y',
      gstin: '07AAACB1234C1Z2',
    });
    expect(dup.status).toBe(409);
  });

  it('opening balance appears in the ledger and the balance; only once', async () => {
    const ob = await shop.post(`/v1/parties/${customerId}/opening-balance`, {
      amount: '12500.50',
      asOf: '2026-04-01',
    });
    expect(ob.status).toBe(204);
    expect(
      (
        await shop.post(`/v1/parties/${customerId}/opening-balance`, {
          amount: 1,
          asOf: '2026-04-01',
        })
      ).status,
    ).toBe(409);

    const ledger = await shop.get(`/v1/parties/${customerId}/ledger`);
    expect(ledger.body).toMatchObject({
      openingBalance: '0.00',
      closingBalance: '12500.50',
      entries: [{ type: 'opening', date: '2026-04-01', debit: '12500.50', balance: '12500.50' }],
    });
    expect((await shop.get(`/v1/parties/${customerId}`)).body.balance).toBe('12500.50');

    const later = await shop.get(`/v1/parties/${customerId}/ledger?from=2026-05-01`);
    expect(later.body).toMatchObject({
      openingBalance: '12500.50',
      closingBalance: '12500.50',
      entries: [],
    });
  });
});

describe('stock', () => {
  let productId: string;

  beforeAll(async () => {
    productId = (await shop.get('/v1/products?search=GL-CLR-5')).body.items[0].id;
  });

  it('opening stock and adjustments, with the movement history', async () => {
    const opening = await shop.post('/v1/stock/adjustments', {
      branchId,
      productId,
      qtyChange: '500',
      reason: 'Opening stock',
      isOpening: true,
    });
    expect(opening.body.qty).toBe('500.000');
    const broken = await shop.post('/v1/stock/adjustments', {
      branchId,
      productId,
      qtyChange: '-12.5',
      reason: 'Breakage',
    });
    expect(broken.body.qty).toBe('487.500');

    const stock = await shop.get(`/v1/stock?branchId=${branchId}`);
    expect(stock.body.items).toMatchObject([{ sku: 'GL-CLR-5', qty: '487.500' }]);
    const moves = await shop.get(`/v1/stock/movements?productId=${productId}`);
    expect(moves.body.items.map((m: { type: string }) => m.type)).toEqual([
      'adjustment_out',
      'opening',
    ]);
  });

  it('cannot remove more than is in stock', async () => {
    const res = await shop.post('/v1/stock/adjustments', {
      branchId,
      productId,
      qtyChange: '-1000',
      reason: 'Recount',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INSUFFICIENT_STOCK');
  });

  it('race: 10 parallel removals of 50 from 487.5 -> exactly 9 succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        shop.post('/v1/stock/adjustments', {
          branchId,
          productId,
          qtyChange: '-50',
          reason: 'Recount',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(9);
    expect(results.filter((r) => r.body.code === 'INSUFFICIENT_STOCK')).toHaveLength(1);
    expect((await shop.get(`/v1/stock?branchId=${branchId}`)).body.items[0].qty).toBe('37.500');
  });
});
