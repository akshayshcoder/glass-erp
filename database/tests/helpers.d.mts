import type pg from 'pg';

export interface TestDatabase {
  /** Pool connected as the API role (RLS enforced), like the real backend. */
  api: pg.Pool;
  /** Connection string for the API role, for code that builds its own pool. */
  apiUrl: string;
  drop(): Promise<void>;
}

export function createTestDatabase(): Promise<TestDatabase>;

export function tx<T>(
  pool: pg.Pool,
  ctx: { tenantId?: string; userId?: string; requestId?: string },
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T>;
