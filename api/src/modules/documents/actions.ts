import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guards } from '../../auth/guards.js';
import type { Role } from '../../auth/roles.js';
import { queryOne } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { AppError, notFound } from '../../http/errors.js';
import { assertBranchAccess, tenantOf } from '../../http/request.js';
import { IdParams, NonEmpty } from '../../http/validation.js';

/*
 * The standard actions every document has, wired to the database functions:
 *
 *   POST   <path>/:id/post      -> erp.<post fn>(id)         freeze + numbers + stock + ledger
 *   POST   <path>/:id/cancel    -> erp.<cancel fn>(id, reason)
 *   DELETE <path>/:id           drafts only
 *
 * Each action runs in one transaction and returns the updated document.
 */

export const CancelBody = z.object({ reason: NonEmpty });

export interface DocumentSpec {
  path: string;
  /** e.g. 'erp.sales_invoices' (constant). */
  table: string;
  entity: string;
  load: (c: DbClient, id: string) => Promise<unknown>;
  post?: { fn: string; roles: readonly Role[] };
  cancel?: { fn: string; roles: readonly Role[] };
  deleteDraft?: { roles: readonly Role[] };
}

export function registerDocumentActions(app: FastifyInstance, guards: Guards, spec: DocumentSpec) {
  /** 404 if missing; 403 if the user may not work in its branch. */
  async function checkAccess(c: DbClient, auth: ReturnType<typeof tenantOf>, id: string) {
    const row = await queryOne<{ branch_id: string }>(
      c,
      `SELECT branch_id FROM ${spec.table} WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound(spec.entity);
    assertBranchAccess(auth, row.branch_id);
  }

  if (spec.post) {
    const { fn, roles } = spec.post;
    app.post(`${spec.path}/:id/post`, { preHandler: guards.tenant(roles) }, async (request) => {
      const { id } = IdParams.parse(request.params);
      return request.tx(async (c) => {
        await checkAccess(c, tenantOf(request), id);
        await c.query(`SELECT erp.${fn}($1)`, [id]);
        return spec.load(c, id);
      });
    });
  }

  if (spec.cancel) {
    const { fn, roles } = spec.cancel;
    app.post(`${spec.path}/:id/cancel`, { preHandler: guards.tenant(roles) }, async (request) => {
      const { id } = IdParams.parse(request.params);
      const { reason } = CancelBody.parse(request.body);
      return request.tx(async (c) => {
        await checkAccess(c, tenantOf(request), id);
        await c.query(`SELECT erp.${fn}($1, $2)`, [id, reason]);
        return spec.load(c, id);
      });
    });
  }

  if (spec.deleteDraft) {
    app.delete(
      `${spec.path}/:id`,
      { preHandler: guards.tenant(spec.deleteDraft.roles) },
      async (request, reply) => {
        const { id } = IdParams.parse(request.params);
        await request.tx(async (c) => {
          await checkAccess(c, tenantOf(request), id);
          const deleted = await queryOne(
            c,
            `DELETE FROM ${spec.table} WHERE id = $1 AND status = 'draft' RETURNING id`,
            [id],
          );
          if (!deleted) {
            throw new AppError(
              409,
              'RECORD_LOCKED',
              `Only draft ${spec.entity.toLowerCase()}s can be deleted`,
            );
          }
        });
        return reply.status(204).send();
      },
    );
  }
}

/**
 * For PUT on drafts: locks the row, checks it is still a draft and that the
 * client edited the latest version.
 */
export async function lockDraftForEdit(
  c: DbClient,
  table: string,
  entity: string,
  id: string,
  version: number,
): Promise<{ branch_id: string }> {
  const row = await queryOne<{ status: string; version: number; branch_id: string }>(
    c,
    `SELECT status, version, branch_id FROM ${table} WHERE id = $1 FOR NO KEY UPDATE`,
    [id],
  );
  if (!row) throw notFound(entity);
  if (row.status !== 'draft') {
    throw new AppError(
      409,
      'RECORD_LOCKED',
      `This ${entity.toLowerCase()} is ${row.status} and can no longer be edited`,
    );
  }
  if (row.version !== version) {
    throw new AppError(
      409,
      'VERSION_CONFLICT',
      'This record was changed by someone else. Reload and try again.',
    );
  }
  return row;
}
