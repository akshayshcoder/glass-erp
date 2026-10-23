import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { query } from '../../db/sql.js';
import { toApi } from '../../http/serialize.js';
import { NonEmpty, Uuid } from '../../http/validation.js';

/**
 * GST period locks. After the accountant files a month's return, they lock it:
 * nothing dated in that month can be posted or cancelled for that branch
 * (corrections go through a credit note in an open month).
 *
 *   GET  /v1/gst-periods?branchId=           locked months
 *   POST /v1/gst-periods/lock   { branchId, period: 'YYYY-MM', note? }      owner, admin, accountant
 *   POST /v1/gst-periods/unlock { branchId, period, reason }               owner, admin (audited)
 */

const Period = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, "Period must be 'YYYY-MM'");
const LockBody = z.object({
  branchId: Uuid,
  period: Period,
  note: z.string().trim().max(500).optional(),
});
const UnlockBody = z.object({ branchId: Uuid, period: Period, reason: NonEmpty });

export function registerGstPeriodRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/gst-periods', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { branchId } = z.object({ branchId: Uuid.optional() }).parse(request.query);
    const rows = await request.tx((c) =>
      query(
        c,
        `SELECT l.branch_id, l.period, l.note, l.locked_at, l.locked_by, u.full_name AS locked_by_name
         FROM erp.gst_period_locks l LEFT JOIN erp.users u ON u.id = l.locked_by
         WHERE ($1::uuid IS NULL OR l.branch_id = $1)
         ORDER BY l.period DESC`,
        [branchId ?? null],
      ),
    );
    return { items: rows.map((r) => toApi(r)) };
  });

  app.post(
    '/gst-periods/lock',
    { preHandler: guards.tenant(Permissions.lockGstPeriod) },
    async (request, reply) => {
      const b = LockBody.parse(request.body);
      await request.tx((c) =>
        c.query('SELECT erp.lock_gst_period($1, $2, $3)', [b.branchId, b.period, b.note ?? null]),
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/gst-periods/unlock',
    { preHandler: guards.tenant(Permissions.unlockGstPeriod) },
    async (request, reply) => {
      const b = UnlockBody.parse(request.body);
      await request.tx((c) =>
        c.query('SELECT erp.unlock_gst_period($1, $2, $3)', [b.branchId, b.period, b.reason]),
      );
      return reply.status(204).send();
    },
  );
}
