import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { containsPattern, query, queryOne } from '../../db/sql.js';
import { PageQuery, readPage, toPage } from '../../http/pagination.js';
import { NonEmpty, Quantity, Uuid } from '../../http/validation.js';

/**
 * Stock levels and movements. Stock only changes through documents
 * (purchases, sales, returns) or an adjustment with a reason; every change is a
 * row in the movement ledger.
 *
 *   GET  /v1/stock?branchId=&search=&lowOnly=true
 *   GET  /v1/stock/movements?productId=&branchId=&pageSize=&pageToken=
 *   POST /v1/stock/adjustments     opening stock, breakage, recount
 */

const StockQuery = z.object({
  branchId: Uuid.optional(),
  search: z.string().trim().optional(),
  lowOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const MovementsQuery = PageQuery.extend({ productId: Uuid.optional(), branchId: Uuid.optional() });

const AdjustmentBody = z.object({
  branchId: Uuid,
  productId: Uuid,
  /** Positive adds stock, negative removes it. */
  qtyChange: Quantity.refine((v) => Number(v) !== 0, 'Cannot be zero'),
  reason: NonEmpty,
  isOpening: z.boolean().default(false),
});

export function registerStockRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/stock', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = StockQuery.parse(request.query);
    const rows = await request.tx((c) =>
      query<{
        branch_id: string;
        product_id: string;
        sku: string;
        name: string;
        kind: string;
        unit_code: string;
        thickness_mm: string | null;
        attributes: Record<string, unknown>;
        qty: string;
        reorder_level: string;
        needs_reorder: boolean;
      }>(
        c,
        `SELECT s.*, p.thickness_mm, p.attributes
         FROM erp.v_stock s
         JOIN erp.products p ON p.id = s.product_id
         WHERE ($1::uuid IS NULL OR s.branch_id = $1)
           AND ($2::text IS NULL
                OR s.name ILIKE $2
                OR s.sku ILIKE $2
                OR coalesce(p.attributes->>'length', '') || ' ' || coalesce(p.attributes->>'lengthUnit', '') ILIKE $2
                OR coalesce(p.thickness_mm::text, '') || 'mm' ILIKE $2)
           AND (NOT $3 OR s.needs_reorder)
         ORDER BY lower(s.name)`,
        [q.branchId ?? null, q.search ? containsPattern(q.search) : null, q.lowOnly],
      ),
    );
    return {
      items: rows.map((r) => ({
        branchId: r.branch_id,
        productId: r.product_id,
        sku: r.sku,
        name: r.name,
        kind: r.kind,
        unitCode: r.unit_code,
        thicknessMm: r.thickness_mm,
        attributes: r.attributes,
        qty: r.qty,
        reorderLevel: r.reorder_level,
        needsReorder: r.needs_reorder,
      })),
    };
  });

  app.get('/stock/movements', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = MovementsQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query<{
        id: string;
        branch_id: string;
        product_id: string;
        movement_type: string;
        qty_change: string;
        balance_after: string;
        ref_type: string | null;
        ref_id: string | null;
        note: string | null;
        created_at: Date;
        created_by: string | null;
      }>(
        c,
        `SELECT * FROM erp.stock_movements
         WHERE ($1::uuid IS NULL OR product_id = $1) AND ($2::uuid IS NULL OR branch_id = $2)
         ORDER BY id DESC
         LIMIT $3 OFFSET $4`,
        [q.productId ?? null, q.branchId ?? null, page.limit + 1, page.offset],
      ),
    );
    const result = toPage(rows, page);
    return {
      items: result.items.map((m) => ({
        id: m.id,
        branchId: m.branch_id,
        productId: m.product_id,
        type: m.movement_type,
        qtyChange: m.qty_change,
        balanceAfter: m.balance_after,
        refType: m.ref_type,
        refId: m.ref_id,
        note: m.note,
        createdAt: m.created_at,
        createdBy: m.created_by,
      })),
      nextPageToken: result.nextPageToken,
    };
  });

  app.post(
    '/stock/adjustments',
    { preHandler: guards.tenant(Permissions.adjustStock) },
    async (request, reply) => {
      const b = AdjustmentBody.parse(request.body);
      const row = await request.tx((c) =>
        queryOne<{ qty: string }>(c, 'SELECT erp.adjust_stock($1, $2, $3, $4, $5)::text AS qty', [
          b.branchId,
          b.productId,
          b.qtyChange,
          b.reason,
          b.isOpening,
        ]),
      );
      return reply
        .status(201)
        .send({ branchId: b.branchId, productId: b.productId, qty: row!.qty });
    },
  );
}
