import type { FastifyReply, FastifyRequest } from 'fastify';
import { queryOne } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';

/*
 * Safe retries for "create document" requests.
 *
 * The client sends `Idempotency-Key: <uuid it generated>`. If the same request
 * arrives twice (double click, mobile network retry, timeout + retry), the
 * second one returns the document created by the first (200 instead of 201)
 * instead of creating a duplicate bill. The database's unique index decides
 * the race when both arrive at the same moment.
 */

export function idempotencyKeyOf(request: FastifyRequest): string | null {
  const key = request.headers['idempotency-key'];
  if (key === undefined) return null;
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_FAILED', 'Idempotency-Key must be 8-200 characters');
  }
  return key;
}

/**
 * Runs `create` once per idempotency key and replies with `load(id)`.
 * `table` is a constant from our code.
 */
export async function createIdempotent<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  table: string,
  create: (c: DbClient, key: string | null) => Promise<string>,
  load: (c: DbClient, id: string) => Promise<T>,
) {
  const key = idempotencyKeyOf(request);
  const findExisting = (c: DbClient) =>
    queryOne<{ id: string }>(c, `SELECT id FROM ${table} WHERE idempotency_key = $1`, [key]);

  if (key) {
    const existing = await request.tx(findExisting);
    if (existing) return reply.status(200).send(await request.tx((c) => load(c, existing.id)));
  }
  try {
    const doc = await request.tx(async (c) => load(c, await create(c, key)));
    return reply.status(201).send(doc);
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (key && e.code === '23505' && e.constraint?.endsWith('_idem_uq')) {
      // Lost the race to an identical request: return its result.
      const existing = await request.tx(findExisting);
      return reply.status(200).send(await request.tx((c) => load(c, existing!.id)));
    }
    throw err;
  }
}
