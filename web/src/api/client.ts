/*
 * The one way the web app talks to the API.
 *
 *   * Access token: kept in memory only (gone on reload, re-obtained silently).
 *   * Refresh token: an httpOnly cookie set by the API, which JavaScript (and so
 *     any injected script) can't read (docs/adr/0006). Every request says
 *     `X-Session-Transport: cookie` to ask for that mode. localStorage only
 *     remembers THAT we are signed in, which is not a secret.
 *   * On 401 the request is retried once after a refresh. Concurrent requests
 *     share one refresh call.
 *   * The selected shop is sent as X-Tenant-Id on every request.
 *   * Errors are thrown as ApiError with the API's stable `code`.
 */

const SIGNED_IN_KEY = 'glass-erp.signedIn';
const TENANT_KEY = 'glass-erp.tenantId';
/** Where older versions kept the refresh token. Moved into the cookie once, then deleted. */
const LEGACY_REFRESH_KEY = 'glass-erp.refreshToken';
const COOKIE_MODE = { 'x-session-transport': 'cookie' };

export interface Problem {
  status: number;
  code: string;
  title: string;
  detail?: unknown;
  requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;

  constructor(problem: Problem) {
    super(problem.title);
    this.status = problem.status;
    this.code = problem.code;
    this.detail = problem.detail;
  }

  /** Field errors from a 400 VALIDATION_FAILED, keyed by field path. */
  get fieldErrors(): Record<string, string> {
    if (this.code !== 'VALIDATION_FAILED' || !Array.isArray(this.detail)) return {};
    return Object.fromEntries(
      (this.detail as { field: string; message: string }[]).map((d) => [d.field, d.message]),
    );
  }
}

interface TokenPair {
  accessToken: string;
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: stays in memory only */
  }
}

/** Session state shared by the whole app. */
export const session = {
  hasSession: () =>
    accessToken !== null || read(SIGNED_IN_KEY) !== null || read(LEGACY_REFRESH_KEY) !== null,
  tenantId: () => read(TENANT_KEY),
  setTenantId(id: string | null) {
    write(TENANT_KEY, id);
    listeners.forEach((l) => l());
  },
  store(tokens: TokenPair) {
    accessToken = tokens.accessToken;
    write(SIGNED_IN_KEY, '1');
    write(LEGACY_REFRESH_KEY, null);
    listeners.forEach((l) => l());
  },
  clear() {
    accessToken = null;
    write(SIGNED_IN_KEY, null);
    write(LEGACY_REFRESH_KEY, null);
    listeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    if (!session.hasSession()) return false;
    const legacy = read(LEGACY_REFRESH_KEY);
    try {
      const res = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...COOKIE_MODE },
        body: JSON.stringify(legacy ? { refreshToken: legacy } : {}),
      });
      if (!res.ok) return false;
      session.store((await res.json()) as TokenPair);
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** Don't send X-Tenant-Id (e.g. before a shop is chosen). */
  noTenant?: boolean;
}

/** Low level: returns the Response (used for PDFs). Throws ApiError when not ok. */
export async function apiFetch(
  path: string,
  opts: RequestOptions = {},
  retried = false,
): Promise<Response> {
  if (!accessToken && session.hasSession()) await refresh();
  const tenantId = opts.noTenant ? null : read(TENANT_KEY);

  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: {
      ...COOKIE_MODE,
      ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      ...(accessToken && { authorization: `Bearer ${accessToken}` }),
      ...(tenantId && { 'x-tenant-id': tenantId }),
      ...opts.headers,
    },
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
  });

  if (res.ok) return res;

  const problem = (await res.json().catch(() => null)) as Problem | null;
  const code = problem?.code ?? 'INTERNAL';
  if (
    res.status === 401 &&
    !retried &&
    (code === 'UNAUTHENTICATED' || code === 'SESSION_REVOKED')
  ) {
    accessToken = null;
    if (await refresh()) return apiFetch(path, opts, true);
    session.clear();
  }
  throw new ApiError(
    problem ?? { status: res.status, code, title: 'Something went wrong. Please try again.' },
  );
}

/** JSON request. */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiFetch(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Turns any error into a message fit for the screen. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Could not reach the server. Check your connection.';
}
