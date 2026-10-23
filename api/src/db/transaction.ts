import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';

/** Who is making the request. Written into the transaction for RLS and the audit trail. */
export interface RequestContext {
  requestId: string;
  userId?: string | null;
  tenantId?: string | null;
  clientIp?: string | null;
}

export type DbClient = pg.PoolClient;

/** Serialization failure / deadlock: safe to retry the whole transaction. */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);
const MAX_ATTEMPTS = 3;

/**
 * Runs `work` in ONE database transaction with the request context set
 * transaction-locally (so a pooled connection never carries it into the next
 * request). Commits on success, rolls back on any error, and retries the whole
 * unit on serialization failures or deadlocks.
 *
 * Every database access of the API goes through here.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  ctx: RequestContext,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE erp_app');
      await client.query(
        `SELECT set_config('app.request_id', $1, true),
                set_config('app.user_id',    $2, true),
                set_config('app.tenant_id',  $3, true),
                set_config('app.client_ip',  $4, true)`,
        [ctx.requestId, ctx.userId ?? '', ctx.tenantId ?? '', ctx.clientIp ?? ''],
      );
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        broken = true; // connection is unusable: destroy it instead of returning it to the pool
      });
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        await sleep(20 * attempt + Math.random() * 30);
        continue;
      }
      throw err;
    } finally {
      client.release(broken);
    }
  }
}

function isRetryable(err: unknown): boolean {
  return RETRYABLE_SQLSTATES.has((err as { code?: string }).code ?? '');
}
