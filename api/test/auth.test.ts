import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FAILED_LOGINS } from '../src/auth/auth.service.js';
import { type Client, nextPhone, signUp, startTestApp } from './test-app.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
let anon: Client;

beforeAll(async () => {
  t = await startTestApp();
  anon = t.client();
});
afterAll(() => t?.close());

describe('register & login', () => {
  it('registers, signs in and returns the profile', async () => {
    const { client, user } = await signUp(anon, 'Ravi Sharma');
    const me = await client.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: user.id, fullName: 'Ravi Sharma' });
    expect(me.body.memberships).toEqual([]);
  });

  it('rejects a duplicate phone number', async () => {
    const phone = nextPhone();
    await anon.post('/v1/auth/register', { fullName: 'A', phone, password: 'password-1' });
    const dup = await anon.post('/v1/auth/register', {
      fullName: 'B',
      phone,
      password: 'password-2',
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE');
  });

  it('validates input with field-level messages', async () => {
    const res = await anon.post('/v1/auth/register', { fullName: '', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    const fields = res.body.detail.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['fullName', 'password']));
  });

  it('needs an email or a phone', async () => {
    const res = await anon.post('/v1/auth/register', {
      fullName: 'No Contact',
      password: 'long-enough',
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toEqual([{ field: 'phone', message: 'Email or phone is required' }]);
  });

  it('gives the same answer for an unknown user and a wrong password', async () => {
    const { phone } = await signUp(anon);
    const unknown = await anon.post('/v1/auth/login', {
      login: nextPhone(),
      password: 'whatever-1',
    });
    const wrong = await anon.post('/v1/auth/login', { login: phone, password: 'wrong-password' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.code).toBe(wrong.body.code);
    expect(unknown.body.title).toBe(wrong.body.title);
  });

  it(`locks the account after ${MAX_FAILED_LOGINS} wrong passwords, even when sent in parallel`, async () => {
    const { phone, password } = await signUp(anon);
    const attempts = await Promise.all(
      Array.from({ length: MAX_FAILED_LOGINS }, () =>
        anon.post('/v1/auth/login', { login: phone, password: 'nope-nope' }),
      ),
    );
    expect(attempts.every((a) => a.status === 401)).toBe(true);

    const correct = await anon.post('/v1/auth/login', { login: phone, password });
    expect(correct.status).toBe(423);
    expect(correct.body.code).toBe('ACCOUNT_LOCKED');
  });
});

describe('sessions', () => {
  it('rejects missing and forged tokens', async () => {
    expect((await anon.get('/v1/me')).status).toBe(401);
    const forged = anon.withToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad');
    expect((await forged.get('/v1/me')).body.code).toBe('UNAUTHENTICATED');
  });

  it('rotates refresh tokens: the old one stops working', async () => {
    const { tokens } = await signUp(anon);
    const first = await anon.post('/v1/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(first.status).toBe(200);
    expect(first.body.refreshToken).not.toBe(tokens.refreshToken);
    expect((await anon.withToken(first.body.accessToken).get('/v1/me')).status).toBe(200);

    const again = await anon.post('/v1/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(again.status).toBe(401);
  });

  it('two tabs refreshing at the same moment: one wins, the session survives', async () => {
    const { tokens, client } = await signUp(anon);
    const [a, b] = await Promise.all([
      anon.post('/v1/auth/refresh', { refreshToken: tokens.refreshToken }),
      anon.post('/v1/auth/refresh', { refreshToken: tokens.refreshToken }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    expect((await client.get('/v1/me')).status).toBe(200);
  });

  it('logout ends the session immediately, before the access token expires', async () => {
    const { client, tokens } = await signUp(anon);
    expect((await client.post('/v1/auth/logout')).status).toBe(204);
    const after = await client.get('/v1/me');
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('SESSION_REVOKED');
    expect(
      (await anon.post('/v1/auth/refresh', { refreshToken: tokens.refreshToken })).status,
    ).toBe(401);
  });

  it('replaying a stolen (already rotated) refresh token ends that login everywhere', async () => {
    const { tokens } = await signUp(anon);
    const rotated = await anon.post('/v1/auth/refresh', { refreshToken: tokens.refreshToken });
    const victim = anon.withToken(rotated.body.accessToken);

    // Pretend the rotation happened a while ago (beyond the two-tabs grace window).
    await t.db.api.query(
      `UPDATE erp.user_sessions SET revoked_at = now() - interval '1 minute'
       WHERE revoked_reason = 'rotated' AND family_id = (
         SELECT family_id FROM erp.user_sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1)`,
    );
    const attacker = await anon.post('/v1/auth/refresh', { refreshToken: tokens.refreshToken });
    expect(attacker.status).toBe(401);
    expect((await victim.get('/v1/me')).body.code).toBe('SESSION_REVOKED');
    expect(
      (await anon.post('/v1/auth/refresh', { refreshToken: rotated.body.refreshToken })).status,
    ).toBe(401);
  });

  it('never stores raw refresh tokens', async () => {
    const { tokens } = await signUp(anon);
    const { rows } = await t.db.api.query(
      'SELECT count(*)::int AS n FROM erp.user_sessions WHERE refresh_token_hash = $1',
      [tokens.refreshToken],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('basics', () => {
  it('returns a request id and problem+json for unknown routes', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/nope',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.json().requestId).toBe('abc-123');
  });

  it('health checks', async () => {
    expect((await anon.get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await anon.get('/readyz')).body).toEqual({ status: 'ok' });
  });
});

describe('reference data', () => {
  it('lists units and GST states for forms', async () => {
    const { client } = await signUp(anon);
    const res = await client.get('/v1/reference');
    expect(res.status).toBe(200);
    expect(res.body.units).toContainEqual({
      code: 'SQFT',
      name: 'Square feet',
      gstUqc: 'SQF',
      decimals: 2,
    });
    expect(res.body.states).toContainEqual({ code: '07', name: 'Delhi' });
  });
});
