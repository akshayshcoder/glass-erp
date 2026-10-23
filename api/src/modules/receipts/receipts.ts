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
 * Receipts: money received from customers, optionally applied to invoices.
 * An amount not applied to any invoice stays as an advance on the customer's
 * ledger. A walk-in (no customer) receipt must be fully applied.
 *
 *   GET    /v1/receipts?partyId=&from=&to=&status=
 *   GET    /v1/receipts/:id
 *   POST   /v1/receipts               { ..., allocations: [{ invoiceId, amount }], post?: true }
 *   POST   /v1/receipts/:id/post
 *   POST   /v1/receipts/:id/cancel    { reason }   (cheque bounced, wrong entry)
 *   DELETE /v1/receipts/:id           drafts only
 */

export const ReceiptBody = z.object({
  branchId: Uuid,
  partyId: Uuid.nullable().optional(),
  mode: PaymentMode,
  amount: PositiveMoney,
  referenceNo: z.string().trim().max(100).optional(),
  receiptDate: IsoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
  allocations: z
    .array(z.object({ invoiceId: Uuid, amount: PositiveMoney }))
    .max(200)
    .default([]),
  autoKnockoff: z.boolean().default(false),
  post: z.boolean().default(false),
});
export type ReceiptInput = Omit<z.infer<typeof ReceiptBody>, 'autoKnockoff'> & {
  autoKnockoff?: boolean;
};

const ListQuery = PageQuery.extend({
  partyId: Uuid.optional(),
  status: z.enum(['draft', 'posted', 'cancelled']).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

/** Inserts (and optionally posts) a receipt inside the caller's transaction. */
export async function insertReceipt(
  c: DbClient,
  b: ReceiptInput,
  idempotencyKey: string | null = null,
) {
  const receipt = await insertRow<{ id: string }>(c, 'erp.receipts', {
    branch_id: b.branchId,
    party_id: b.partyId ?? null,
    mode: b.mode,
    amount: b.amount,
    reference_no: b.referenceNo ?? null,
    notes: b.notes ?? null,
    idempotency_key: idempotencyKey,
    ...(b.receiptDate && { receipt_date: b.receiptDate }),
  });
  for (const a of b.allocations) {
    await insertRow(c, 'erp.receipt_allocations', {
      receipt_id: receipt.id,
      invoice_id: a.invoiceId,
      amount: a.amount,
    });
  }
  if (b.post) {
    await c.query('SELECT erp.post_receipt($1)', [receipt.id]);
    if (b.autoKnockoff && b.partyId) {
      await c.query('SELECT erp.settle_customer_fifo($1)', [b.partyId]);
    }
  }
  return receipt.id;
}

export async function loadReceipt(c: DbClient, id: string) {
  const r = await queryOne(c, 'SELECT * FROM erp.receipts WHERE id = $1', [id]);
  if (!r) throw notFound('Receipt');
  const allocations = await query<{
    invoice_id: string;
    invoice_no: string | null;
    amount: string;
  }>(
    c,
    `SELECT a.invoice_id, i.invoice_no, a.amount
     FROM erp.receipt_allocations a JOIN erp.sales_invoices i ON i.id = a.invoice_id
     WHERE a.receipt_id = $1 ORDER BY i.invoice_no`,
    [id],
  );
  const advanceAllocations = await query<{
    invoice_id: string;
    invoice_no: string | null;
    amount: string;
  }>(
    c,
    `SELECT a.invoice_id, i.invoice_no, a.amount
     FROM erp.advance_allocations a JOIN erp.sales_invoices i ON i.id = a.invoice_id
     WHERE a.receipt_id = $1 ORDER BY a.created_at`,
    [id],
  );
  const adv = await queryOne<{ unallocated_amount: string }>(
    c,
    'SELECT unallocated_amount FROM erp.v_receipt_advance WHERE receipt_id = $1',
    [id],
  );
  return {
    ...toApi(r),
    allocations: allocations.map((a) => toApi(a)),
    advanceAllocations: advanceAllocations.map((a) => toApi(a)),
    unallocatedAmount: adv?.unallocated_amount ?? '0.00',
  };
}

export function registerReceiptRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/receipts', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = ListQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query(
        c,
        `SELECT r.*, p.name AS party_name FROM erp.receipts r LEFT JOIN erp.parties p ON p.id = r.party_id
         WHERE ($1::uuid IS NULL OR r.party_id = $1) AND ($2::text IS NULL OR r.status = $2)
           AND ($3::date IS NULL OR r.receipt_date >= $3) AND ($4::date IS NULL OR r.receipt_date <= $4)
         ORDER BY r.receipt_date DESC, r.created_at DESC
         LIMIT $5 OFFSET $6`,
        [
          q.partyId ?? null,
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
  });

  app.get('/receipts/:id', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    return request.tx((c) => loadReceipt(c, id));
  });

  app.post('/receipts', { preHandler: guards.tenant(Permissions.sell) }, async (request, reply) => {
    const body = ReceiptBody.parse(request.body);
    assertBranchAccess(tenantOf(request), body.branchId);
    return createIdempotent(
      request,
      reply,
      'erp.receipts',
      (c, key) => insertReceipt(c, body, key),
      loadReceipt,
    );
  });

  registerDocumentActions(app, guards, {
    path: '/receipts',
    table: 'erp.receipts',
    entity: 'Receipt',
    load: loadReceipt,
    post: { fn: 'post_receipt', roles: Permissions.sell },
    cancel: { fn: 'cancel_receipt', roles: Permissions.cancelSales },
    deleteDraft: { roles: Permissions.sell },
  });
}
