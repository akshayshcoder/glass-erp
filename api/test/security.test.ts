import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextPhone, startTestApp } from './test-app.js';

const AUTH_LIMIT = 4;
const password = 'correct-horse-battery';

// Two apps: a development-like one with a small sign-in limit, and a
// production-like one (HTTPS cookies) that also serves a built web app.
let dev: Awaited<ReturnType<typeof startTestApp>>;
let prod: Awaited<ReturnType<typeof startTestApp>>;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), 'glass-erp-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');

  [dev, prod] = await Promise.all([
    startTestApp({ AUTH_RATE_LIMIT_PER_MINUTE: String(AUTH_LIMIT) }),
    startTestApp({ COOKIE_SECURE: 'true', WEB_DIST_DIR: webDir }),
  ]);
});
afterAll(async () => {
  await Promise.all([dev?.close(), prod?.close()]);
  rmSync(webDir, { recursive: true, force: true });
});

const cookieMode = { 'x-session-transport': 'cookie' };

async function registerUser(app: typeof prod) {
  const phone = nextPhone();
  await app.client().post('/v1/auth/register', { fullName: 'Cookie User', phone, password });
  return phone;
}

describe('refresh token in an httpOnly cookie (browsers)', () => {
  it('login sets the cookie and leaves the token out of the body', async () => {
    const phone = await registerUser(prod);
    const res = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { login: phone, password },
      headers: cookieMode,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    expect(res.json().refreshToken).toBeUndefined();

    const cookie = res.cookies.find((c) => c.name === 'erp_refresh')!;
    expect(cookie).toMatchObject({
      path: '/v1/auth',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    });
    expect(cookie.value.length).toBeGreaterThan(20);
  });

  it('refresh rotates the cookie; the old one stops working and gets cleared', async () => {
    const phone = await registerUser(prod);
    const login = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { login: phone, password },
      headers: cookieMode,
    });
    const first = login.cookies.find((c) => c.name === 'erp_refresh')!.value;

    const refreshed = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: cookieMode,
      cookies: { erp_refresh: first },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().refreshToken).toBeUndefined();
    const second = refreshed.cookies.find((c) => c.name === 'erp_refresh')!.value;
    expect(second).not.toBe(first);

    const replay = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: cookieMode,
      cookies: { erp_refresh: first },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.cookies.find((c) => c.name === 'erp_refresh')!.value).toBe('');
  });

  it('ignores the cookie without the X-Session-Transport header (cross-site requests)', async () => {
    const phone = await registerUser(prod);
    const login = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { login: phone, password },
      headers: cookieMode,
    });
    const token = login.cookies.find((c) => c.name === 'erp_refresh')!.value;
    const res = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { erp_refresh: token },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const phone = await registerUser(prod);
    const login = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { login: phone, password },
      headers: cookieMode,
    });
    const res = await prod.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { ...cookieMode, authorization: `Bearer ${login.json().accessToken}` },
    });
    expect(res.statusCode).toBe(204);
    expect(res.cookies.find((c) => c.name === 'erp_refresh')!.value).toBe('');
  });

  it('scripts and apps without the header still get the token in the body', async () => {
    const phone = await registerUser(prod);
    const login = await prod.client().post('/v1/auth/login', { login: phone, password });
    expect(login.body.refreshToken).toBeTruthy();
  });
});

describe('rate limits', () => {
  it(`allows ${AUTH_LIMIT} sign-in attempts per minute per IP, then answers 429`, async () => {
    const anon = dev.client();
    const tries = [];
    for (let i = 0; i <= AUTH_LIMIT; i++) {
      tries.push(
        await anon.raw(
          'POST',
          '/v1/auth/login',
          { login: nextPhone(), password: 'x' },
          {
            // A client can't escape the limit by inventing proxy headers.
            'x-forwarded-for': `203.0.113.${i}`,
          },
        ),
      );
    }
    expect(tries.slice(0, AUTH_LIMIT).every((r) => r.statusCode === 401)).toBe(true);
    const blocked = tries[AUTH_LIMIT]!;
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['content-type']).toContain('application/problem+json');
    expect(blocked.json().code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    // Other endpoints keep their own, generous limit.
    expect((await anon.get('/v1/me')).status).toBe(401);
    expect((await anon.get('/healthz')).status).toBe(200);
  });
});

describe('security headers', () => {
  it('sends a strict Content-Security-Policy and friends; no HSTS over plain HTTP', async () => {
    const res = await dev.app.inject({ method: 'GET', url: '/healthz' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('upgrade-insecure-requests');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS when served over HTTPS', async () => {
    const res = await prod.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('serving the web app (WEB_DIST_DIR)', () => {
  const html = { accept: 'text/html,application/xhtml+xml' };

  it('serves index.html for app pages, never cached', async () => {
    for (const url of ['/', '/invoices/123', '/reports/gst?period=2026-09']) {
      const res = await prod.app.inject({ method: 'GET', url, headers: html });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<div id="root">');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['content-security-policy']).toBeTruthy();
    }
  });

  it('caches fingerprinted assets for a year', async () => {
    const res = await prod.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('immutable');
  });

  it('keeps API and missing-file errors as JSON 404s', async () => {
    const api = await prod.app.inject({ method: 'GET', url: '/v1/nope', headers: html });
    expect(api.statusCode).toBe(404);
    expect(api.json().code).toBe('NOT_FOUND');
    const file = await prod.app.inject({ method: 'GET', url: '/missing.png', headers: html });
    expect(file.statusCode).toBe(404);
  });
});
