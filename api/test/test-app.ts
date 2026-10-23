import { createTestDatabase } from '@glass-erp/database/testing';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

/**
 * A real app on a real, throw-away PostgreSQL database (all migrations
 * applied), connected as the API role. Needs DATABASE_ADMIN_URL, see README.
 */
export async function startTestApp(env: Record<string, string> = {}) {
  const db = await createTestDatabase();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: db.apiUrl,
    JWT_SECRET: 'test-secret-that-is-long-enough-for-hs256-signing',
    // Every test signs up from the same address; security.test.ts checks the real limits.
    RATE_LIMIT_PER_MINUTE: '100000',
    AUTH_RATE_LIMIT_PER_MINUTE: '100000',
    ...env,
  });
  const app = await buildApp({ config, pool: db.api });
  return {
    app,
    db,
    client: () => new Client(app),
    async close() {
      await app.close();
      await db.drop();
    },
  };
}

export interface Response<T = any> {
  status: number;
  body: T;
}

/** Minimal HTTP client over app.inject(), carrying the token and selected shop. */
export class Client {
  constructor(
    private readonly app: FastifyInstance,
    readonly token?: string,
    readonly tenantId?: string,
  ) {}

  withToken(token: string) {
    return new Client(this.app, token, this.tenantId);
  }

  inShop(tenantId: string) {
    return new Client(this.app, this.token, tenantId);
  }

  /** The raw response (status, headers, bytes), e.g. for PDFs. */
  raw(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return this.app.inject({
      method,
      url,
      ...(body !== undefined && { payload: body as object }),
      headers: {
        ...(this.token && { authorization: `Bearer ${this.token}` }),
        ...(this.tenantId && { 'x-tenant-id': this.tenantId }),
        ...headers,
      },
    });
  }

  async request<T = any>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response<T>> {
    const res = await this.raw(method, url, body, headers);
    return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
  }

  get = <T = any>(url: string) => this.request<T>('GET', url);
  post = <T = any>(url: string, body?: unknown, headers?: Record<string, string>) =>
    this.request<T>('POST', url, body, headers);
  put = <T = any>(url: string, body?: unknown) => this.request<T>('PUT', url, body);
  del = <T = any>(url: string) => this.request<T>('DELETE', url);
  patch = <T = any>(url: string, body?: unknown) => this.request<T>('PATCH', url, body);
}

let phoneSeq = 9_000_000_000;
export const nextPhone = () => String(++phoneSeq);

/** Registers a user and signs in. Returns a client carrying their token. */
export async function signUp(
  client: Client,
  fullName = 'Test User',
  password = 'correct-horse-battery',
) {
  const phone = nextPhone();
  const reg = await client.post('/v1/auth/register', { fullName, phone, password });
  if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
  const login = await client.post('/v1/auth/login', { login: phone, password });
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
  return {
    user: reg.body as { id: string },
    phone,
    password,
    tokens: login.body as { accessToken: string; refreshToken: string },
    client: client.withToken(login.body.accessToken),
  };
}

/** Creates a shop owned by `client`'s user and returns a client inside it. */
export async function createShop(client: Client, name = 'Sharma Glass House', code = 'MAIN') {
  const res = await client.post('/v1/tenants', {
    name,
    branch: { code, name: 'Main Shop', stateCode: '07', gstin: '07ABCDE1234F1Z5' },
  });
  if (res.status !== 201) throw new Error(`create shop failed: ${JSON.stringify(res.body)}`);
  return client.inShop(res.body.id);
}
