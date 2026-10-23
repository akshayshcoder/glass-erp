import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import {
  containsPattern,
  insertLines,
  insertRow,
  query,
  queryOne,
  updateVersioned,
} from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { AppError, notFound } from '../../http/errors.js';
import { PageQuery, readPage, toPage } from '../../http/pagination.js';
import { assertBranchAccess, tenantOf } from '../../http/request.js';
import { toApi } from '../../http/serialize.js';
import { IdParams, IsoDate, NonEmpty, Uuid, Version } from '../../http/validation.js';
import { lockDraftForEdit, registerDocumentActions } from '../documents/actions.js';
import { createIdempotent } from '../documents/idempotency.js';
import {
  LinesInput,
  loadProducts,
  previewResponse,
  priceLines,
  totalsColumns,
} from '../documents/lines.js';
import { loadActiveBranch } from '../documents/parties.js';

/**
 * Purchase bills: a supplier's invoice, entered by the shop. Posting adds the
 * goods to stock, credits the supplier's ledger and updates the product's last
 * purchase price. The supplier's own bill number can't be entered twice.
 *
 *   GET    /v1/purchase-bills?status=&supplierId=&from=&to=&search=
 *   GET    /v1/purchase-bills/:id
 *   POST   /v1/purchase-bills            draft (post: true to post immediately)
 *   PUT    /v1/purchase-bills/:id        replace a draft (send version)
 *   POST   /v1/purchase-bills/:id/post
 *   POST   /v1/purchase-bills/:id/cancel { reason }   refused if the goods were already sold
 *   DELETE /v1/purchase-bills/:id        drafts only
 *
 * GST: supplier's state vs the branch's state decides CGST+SGST or IGST.
 * Default line rate: the product's last purchase price.
 */

const BillFields = z.object({
  branchId: Uuid,
  supplierId: Uuid,
  supplierInvoiceNo: NonEmpty,
  supplierInvoiceDate: IsoDate,
  entryDate: IsoDate.optional(),
  reverseCharge: z.boolean().default(false),
  itcEligible: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional(),
  lines: LinesInput,
});
const CreateBody = BillFields.extend({ post: z.boolean().default(false) });
const UpdateBody = BillFields.extend({ version: Version });
/** While typing, the supplier's bill number/date may not be filled in yet. */
const PreviewBody = BillFields.partial({ supplierInvoiceNo: true, supplierInvoiceDate: true });

const ListQuery = PageQuery.extend({
  status: z.enum(['draft', 'posted', 'cancelled']).optional(),
  supplierId: Uuid.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  search: z.string().trim().optional(),
  /** Only posted bills with money still to pay (for the supplier-payment screen). */
  unpaid: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

async function buildBill(c: DbClient, input: z.infer<typeof PreviewBody>) {
  const branch = await loadActiveBranch(c, input.branchId);
  const supplier = await queryOne<{
    id: string;
    kind: string;
    name: string;
    gstin: string | null;
    state_code: string | null;
    is_active: boolean;
  }>(c, 'SELECT id, kind, name, gstin, state_code, is_active FROM erp.parties WHERE id = $1', [
    input.supplierId,
  ]);
  if (!supplier) throw new AppError(422, 'INVALID_REFERENCE', 'Supplier not found');
  if (supplier.kind === 'customer')
    throw new AppError(422, 'BUSINESS_RULE', `"${supplier.name}" is not a supplier`);
  if (!supplier.is_active)
    throw new AppError(422, 'BUSINESS_RULE', `"${supplier.name}" is inactive`);
  if (!supplier.state_code) {
    throw new AppError(
      422,
      'BUSINESS_RULE',
      `Set the state (or GSTIN) of "${supplier.name}" to calculate GST`,
    );
  }

  const products = await loadProducts(
    c,
    input.lines.map((l) => l.productId),
  );
  const { lines, totals } = priceLines(input.lines, products, {
    interState: supplier.state_code !== branch.state_code,
    storeSize: false,
    defaultRate: (p) => p.purchase_price,
  });
  const header = {
    branch_id: branch.id,
    supplier_id: supplier.id,
    supplier_name: supplier.name,
    supplier_gstin: supplier.gstin,
    supplier_invoice_no: input.supplierInvoiceNo,
    supplier_invoice_date: input.supplierInvoiceDate,
    supplier_state_code: supplier.state_code,
    buyer_state_code: branch.state_code,
    reverse_charge: input.reverseCharge,
    itc_eligible: input.itcEligible,
    notes: input.notes ?? null,
    ...(input.entryDate && { entry_date: input.entryDate }),
    ...totalsColumns(totals),
  };
  return { header, lines };
}

export async function loadPurchaseBill(c: DbClient, id: string): Promise<Record<string, unknown>> {
  const bill = await queryOne(
    c,
    `SELECT b.*, (b.grand_total - b.amount_paid)::numeric(14,2) AS balance_due
     FROM erp.purchase_bills b WHERE b.id = $1`,
    [id],
  );
  if (!bill) throw notFound('Purchase bill');
  const lines = await query(
    c,
    'SELECT * FROM erp.purchase_bill_lines WHERE bill_id = $1 ORDER BY line_no',
    [id],
  );
  return { ...toApi(bill), lines: lines.map((l) => toApi(l, ['bill_id'])) };
}

function duplicateBill(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23505' && e.constraint === 'purchase_bills_supplier_bill_uq') {
    throw new AppError(
      409,
      'DUPLICATE',
      'This supplier bill number is already entered for this supplier',
    );
  }
  throw err;
}

export function registerPurchaseBillRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/purchase-bills', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = ListQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query(
        c,
        `SELECT id, branch_id, status, doc_no, entry_date, supplier_id, supplier_name, supplier_invoice_no,
                supplier_invoice_date, grand_total, amount_paid, (grand_total - amount_paid)::numeric(14,2) AS balance_due
         FROM erp.purchase_bills
         WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR supplier_id = $2)
           AND ($3::date IS NULL OR entry_date >= $3) AND ($4::date IS NULL OR entry_date <= $4)
           AND ($5::text IS NULL OR doc_no ILIKE $5 OR supplier_invoice_no ILIKE $5 OR supplier_name ILIKE $5)
           AND (NOT $8 OR (status = 'posted' AND grand_total - amount_paid > 0))
         ORDER BY entry_date DESC, created_at DESC
         LIMIT $6 OFFSET $7`,
        [
          q.status ?? null,
          q.supplierId ?? null,
          q.from ?? null,
          q.to ?? null,
          q.search ? containsPattern(q.search) : null,
          page.limit + 1,
          page.offset,
          q.unpaid,
        ],
      ),
    );
    const result = toPage(rows, page);
    return { items: result.items.map((r) => toApi(r)), nextPageToken: result.nextPageToken };
  });

  app.get(
    '/purchase-bills/:id',
    { preHandler: guards.tenant(Permissions.read) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      return request.tx((c) => loadPurchaseBill(c, id));
    },
  );

  // Prices a bill without saving it (live totals on the purchase entry screen).
  app.post(
    '/purchase-bills/preview',
    { preHandler: guards.tenant(Permissions.purchase) },
    async (request) => {
      const body = PreviewBody.parse(request.body);
      assertBranchAccess(tenantOf(request), body.branchId);
      return request.tx(async (c) => {
        const { header, lines } = await buildBill(c, body);
        return previewResponse(header, lines);
      });
    },
  );

  app.post(
    '/purchase-bills',
    { preHandler: guards.tenant(Permissions.purchase) },
    async (request, reply) => {
      const body = CreateBody.parse(request.body);
      assertBranchAccess(tenantOf(request), body.branchId);
      return createIdempotent(
        request,
        reply,
        'erp.purchase_bills',
        async (c, key) => {
          const { header, lines } = await buildBill(c, body);
          const bill = await insertRow<{ id: string }>(c, 'erp.purchase_bills', {
            ...header,
            idempotency_key: key,
          }).catch(duplicateBill);
          await insertLines(c, 'erp.purchase_bill_lines', 'bill_id', bill.id, lines);
          if (body.post) await c.query('SELECT erp.post_purchase_bill($1)', [bill.id]);
          return bill.id;
        },
        loadPurchaseBill,
      );
    },
  );

  app.put(
    '/purchase-bills/:id',
    { preHandler: guards.tenant(Permissions.purchase) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const body = UpdateBody.parse(request.body);
      const auth = tenantOf(request);
      assertBranchAccess(auth, body.branchId);
      return request.tx(async (c) => {
        const current = await lockDraftForEdit(
          c,
          'erp.purchase_bills',
          'Purchase bill',
          id,
          body.version,
        );
        assertBranchAccess(auth, current.branch_id);
        const { header, lines } = await buildBill(c, body);
        const columns = Object.fromEntries(Object.keys(header).map((k) => [k, k]));
        await updateVersioned(
          c,
          'erp.purchase_bills',
          'Purchase bill',
          id,
          body.version,
          columns,
          header,
        ).catch(duplicateBill);
        await c.query('DELETE FROM erp.purchase_bill_lines WHERE bill_id = $1', [id]);
        await insertLines(c, 'erp.purchase_bill_lines', 'bill_id', id, lines);
        return loadPurchaseBill(c, id);
      });
    },
  );

  registerDocumentActions(app, guards, {
    path: '/purchase-bills',
    table: 'erp.purchase_bills',
    entity: 'Purchase bill',
    load: loadPurchaseBill,
    post: { fn: 'post_purchase_bill', roles: Permissions.purchase },
    cancel: { fn: 'cancel_purchase_bill', roles: Permissions.cancelPurchase },
    deleteDraft: { roles: Permissions.purchase },
  });
}
