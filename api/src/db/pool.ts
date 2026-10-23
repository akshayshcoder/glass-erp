import pg from 'pg';

/**
 * How PostgreSQL values arrive in JavaScript. Global to the `pg` module, so it
 * is applied by buildApp() itself: however the app is started (server, tests,
 * scripts), dates behave the same.
 *
 *   DATE    -> 'YYYY-MM-DD' string. The default (a JS Date at local midnight)
 *              silently shifts business dates across timezones.
 *   NUMERIC -> string (pg default, kept): money never passes through a float.
 *   INT8    -> string (pg default, kept).
 */
export function configurePgTypes(): void {
  pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
}

export interface PoolOptions {
  connectionString: string;
  max: number;
  onError?: (err: Error) => void;
}

export function createPool({ connectionString, max, onError }: PoolOptions): pg.Pool {
  const pool = new pg.Pool({ connectionString, max });
  // An idle client can be killed by the server (restart, failover). Without a
  // listener this would crash the process.
  pool.on('error', (err) => onError?.(err));
  return pool;
}
