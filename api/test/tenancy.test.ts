import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, createShop, signUp, startTestApp } from './test-app.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let anon: Client;

beforeAll(async () => {
  t = await startTestApp();
  anon = t.client();
});
afterAll(() => t?.close());

async function memberOf(owner: Client, role: string) {
  const person = await signUp(anon, `A ${role}`);
  const add = await owner.post('/v1/members', { login: person.phone, role });
  expect(add.status).toBe(201);
  return {
    ...person,
    memberId: add.body.id as string,
    shop: person.client.inShop(owner.tenantId!),
  };
}

describe('shops', () => {
  it('sign-up creates a shop with its first branch and makes the user owner', async () => {
    const { client } = await signUp(anon, 'Owner');
    const shop = await createShop(client);

    const me = await client.get('/v1/me');
    expect(me.body.memberships).toEqual([
      { tenantId: shop.tenantId, tenantName: 'Sharma Glass House', role: 'owner' },
    ]);
    const branches = await shop.get('/v1/branches');
    expect(branches.body.items).toMatchObject([
      { code: 'MAIN', gstin: '07ABCDE1234F1Z5', stateCode: '07' },
    ]);
  });

  it('rejects a GSTIN that does not match the state', async () => {
    const { client } = await signUp(anon);
    const res = await client.post('/v1/tenants', {
      name: 'X',
      branch: { code: 'X', name: 'X', stateCode: '27', gstin: '07ABCDE1234F1Z5' },
    });
    expect(res.status).toBe(400);
  });

  it('shop endpoints need a selected shop the user belongs to', async () => {
    const a = await signUp(anon);
    const b = await signUp(anon);
    const shopA = await createShop(a.client, 'Shop A', 'A');

    expect((await a.client.get('/v1/products')).body.code).toBe('TENANT_REQUIRED');
    const intruder = await b.client.inShop(shopA.tenantId!).get('/v1/products');
    expect(intruder.status).toBe(403);
    expect(intruder.body.code).toBe('NOT_A_MEMBER');
  });

  it('optimistic locking on the shop profile', async () => {
    const { client } = await signUp(anon);
    const shop = await createShop(client);
    expect(
      (await shop.patch('/v1/tenant', { version: 1, legalName: 'Sharma Glass Pvt Ltd' })).status,
    ).toBe(200);
    const stale = await shop.patch('/v1/tenant', { version: 1, name: 'Other' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('VERSION_CONFLICT');
  });
});

describe('team & roles', () => {
  it('an accountant can work in several shops, with one login', async () => {
    const acct = await signUp(anon, 'CA Verma');
    for (const [name, code] of [
      ['Shop One', 'ONE'],
      ['Shop Two', 'TWO'],
    ] as const) {
      const { client } = await signUp(anon);
      const shop = await createShop(client, name, code);
      await shop.post('/v1/members', { login: acct.phone, role: 'accountant' });
    }
    const me = await acct.client.get('/v1/me');
    expect(me.body.memberships.map((m: { tenantName: string }) => m.tenantName)).toEqual([
      'Shop One',
      'Shop Two',
    ]);
  });

  it('roles limit what members can do', async () => {
    const { client } = await signUp(anon);
    const shop = await createShop(client);
    const cashier = await memberOf(shop, 'billing');
    const accountant = await memberOf(shop, 'accountant');

    const product = {
      sku: 'P1',
      name: 'Handle',
      kind: 'hardware',
      hsnCode: '8302',
      gstRate: '18',
      unitCode: 'PCS',
    };
    expect((await accountant.shop.post('/v1/products', product)).status).toBe(403);
    expect((await accountant.shop.get('/v1/products')).status).toBe(200);
    expect(
      (await cashier.shop.post('/v1/members', { login: '9999999999', role: 'viewer' })).status,
    ).toBe(403);
    expect(
      (await cashier.shop.post('/v1/parties', { kind: 'customer', name: 'Walk-in Co' })).status,
    ).toBe(201);
  });

  it('removing someone from the shop takes effect on their next request', async () => {
    const { client } = await signUp(anon);
    const shop = await createShop(client);
    const viewer = await memberOf(shop, 'viewer');
    expect((await viewer.shop.get('/v1/products')).status).toBe(200);

    await shop.patch(`/v1/members/${viewer.memberId}`, { version: 1, status: 'disabled' });
    expect((await viewer.shop.get('/v1/products')).body.code).toBe('NOT_A_MEMBER');
  });

  it('only an owner can create another owner', async () => {
    const { client } = await signUp(anon);
    const shop = await createShop(client);
    const admin = await memberOf(shop, 'admin');
    const someone = await signUp(anon);
    expect(
      (await admin.shop.post('/v1/members', { login: someone.phone, role: 'owner' })).status,
    ).toBe(403);
    expect(
      (await admin.shop.post('/v1/members', { login: someone.phone, role: 'manager' })).status,
    ).toBe(201);
  });

  it('the last owner cannot be demoted', async () => {
    const owner = await signUp(anon);
    const shop = await createShop(owner.client);
    const members = await shop.get('/v1/members');
    const self = members.body.items[0];
    const res = await shop.patch(`/v1/members/${self.id}`, {
      version: self.version,
      role: 'admin',
    });
    expect(res.status).toBe(422);
  });

  it('race: two owners demote each other at the same moment, the shop keeps one owner', async () => {
    const first = await signUp(anon);
    const shop = await createShop(first.client);
    const second = await memberOf(shop, 'owner');
    const firstId = (await shop.get('/v1/members')).body.items.find(
      (m: { userId: string }) => m.userId === first.user.id,
    ).id;

    const results = await Promise.all([
      shop.patch(`/v1/members/${second.memberId}`, { version: 1, role: 'admin' }),
      second.shop.patch(`/v1/members/${firstId}`, { version: 1, role: 'admin' }),
    ]);
    // Whoever gets the lock second is refused: 422 (would remove the last owner)
    // or 403 (they themselves were just demoted). Never both succeed.
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([403, 422]).toContain(statuses[1]);

    const members = await shop.get('/v1/members'); // both are still owner or admin, both may list
    expect(members.body.items.filter((m: { role: string }) => m.role === 'owner')).toHaveLength(1);
  });
});
