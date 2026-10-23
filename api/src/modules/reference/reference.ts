import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { query } from '../../db/sql.js';
import { toApi } from '../../http/serialize.js';

/**
 * Global reference data for forms (same for every shop).
 *
 *   GET /v1/reference -> { units: [{ code, name, gstUqc, decimals }], states: [{ code, name }] }
 */
export function registerReferenceRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/reference', { preHandler: guards.user }, async (request, reply) => {
    const data = await request.tx(async (c) => ({
      units: (
        await query(c, 'SELECT code, name, gst_uqc, decimals FROM erp.units ORDER BY name')
      ).map((r) => toApi(r)),
      states: (await query(c, 'SELECT code, name FROM erp.states ORDER BY name')).map((r) =>
        toApi(r),
      ),
    }));
    // Changes only with a migration: let browsers cache it for an hour.
    return reply.header('cache-control', 'private, max-age=3600').send(data);
  });
}
