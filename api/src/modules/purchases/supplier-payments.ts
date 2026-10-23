import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { insertRow, query, queryOne } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { PageQuery, readPage, toPage } from '../../http/pagination.js';
import { assertBranchAccess, tenantOf } from '../../http/request.js';
import { toApi } from '../../http/serialize.js';
import { IdParams, IsoDate, PaymentMode, PositiveMoney, Uuid } from '../../http/validation.js';
import { registerDocumentActions } from '../documents/actions.js';
import { createIdempotent } from '../documents/idempotency.js';

/**
 * Payments made to suppliers, optionally applied to purchase bills (the rest is
 * an advance to the supplier).
 *
 *   GET    /v1/supplier-payments?supplierId=&from=&to=&status=
 *   GET    /v1/supplier-payments/:id
 *   POST   /v1/supplier-payments            { ..., allocations: [{ billId, amount }], post?: true }
 *   POST   /v1/supplier-payments/:id/post
 *   POST   /v1/supplier-payments/:id/cancel { reason }
 *   DELETE /v1/supplier-payments/:id        drafts only
 */

const PaymentBody = z.object({
  branchId: Uuid,
  supplierId: Uuid,
  mode: PaymentMode,
  amount: PositiveMoney,
  referenceNo: z.string().trim().max(100).optional(),
  paymentDate: IsoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
  allocations: z
    .array(z.object({ billId: Uuid, amount: PositiveMoney }))
    .max(200)
    .default([]),
  post: z.boolean().default(false),
});

const ListQuery = PageQuery.extend({
  supplierId: Uuid.optional(),
  status: z.enum(['draft', 'posted', 'cancelled']).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

async function loadSupplierPayment(c: DbClient, id: string): Promise<Record<string, unknown>> {
  const p = await queryOne(c, 'SELECT * FROM erp.supplier_payments WHERE id = $1', [id]);
  if (!p) throw notFound('Payment');
  const allocations = await query(
    c,
    `SELECT a.bill_id, b.doc_no, b.supplier_invoice_no, a.amount
     FROM erp.supplier_payment_allocations a JOIN erp.purchase_bills b ON b.id = a.bill_id
     WHERE a.payment_id = $1 ORDER BY b.doc_no`,
    [id],
  );
  return { ...toApi(p), allocations: allocations.map((a) => toApi(a)) };
}

export function registerSupplierPaymentRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get(
    '/supplier-payments',
    { preHandler: guards.tenant(Permissions.read) },
    async (request) => {
      const q = ListQuery.parse(request.query);
      const page = readPage(q);
      const rows = await request.tx((c) =>
        query(
          c,
          `SELECT s.*, p.name AS supplier_name
         FROM erp.supplier_payments s JOIN erp.parties p ON p.id = s.supplier_id
         WHERE ($1::uuid IS NULL OR s.supplier_id = $1) AND ($2::text IS NULL OR s.status = $2)
           AND ($3::date IS NULL OR s.payment_date >= $3) AND ($4::date IS NULL OR s.payment_date <= $4)
         ORDER BY s.payment_date DESC, s.created_at DESC
         LIMIT $5 OFFSET $6`,
          [
            q.supplierId ?? null,
            q.status ?? null,
            q.from ?? null,
            q.to ?? null,
            page.limit + 1,
            page.offset,
          ],
        ),
      );
      const result = toPage(rows, page);
      return { items: result.items.map((r) => toApi(r)), nextPageToken: result.nextPageToken };
    },
  );

  app.get(
    '/supplier-payments/:id',
    { preHandler: guards.tenant(Permissions.read) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      return request.tx((c) => loadSupplierPayment(c, id));
    },
  );

  app.post(
    '/supplier-payments',
    { preHandler: guards.tenant(Permissions.paySuppliers) },
    async (request, reply) => {
      const b = PaymentBody.parse(request.body);
      assertBranchAccess(tenantOf(request), b.branchId);
      return createIdempotent(
        request,
        reply,
        'erp.supplier_payments',
        async (c, key) => {
          const payment = await insertRow<{ id: string }>(c, 'erp.supplier_payments', {
            branch_id: b.branchId,
            supplier_id: b.supplierId,
            mode: b.mode,
            amount: b.amount,
            reference_no: b.referenceNo ?? null,
            notes: b.notes ?? null,
            idempotency_key: key,
            ...(b.paymentDate && { payment_date: b.paymentDate }),
          });
          for (const a of b.allocations) {
            await insertRow(c, 'erp.supplier_payment_allocations', {
              payment_id: payment.id,
              bill_id: a.billId,
              amount: a.amount,
            });
          }
          if (b.post) await c.query('SELECT erp.post_supplier_payment($1)', [payment.id]);
          return payment.id;
        },
        loadSupplierPayment,
      );
    },
  );

  registerDocumentActions(app, guards, {
    path: '/supplier-payments',
    table: 'erp.supplier_payments',
    entity: 'Payment',
    load: loadSupplierPayment,
    post: { fn: 'post_supplier_payment', roles: Permissions.paySuppliers },
    cancel: { fn: 'cancel_supplier_payment', roles: Permissions.paySuppliers },
    deleteDraft: { roles: Permissions.paySuppliers },
  });
}
