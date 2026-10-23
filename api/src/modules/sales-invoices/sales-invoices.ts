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
import { notFound } from '../../http/errors.js';
import { PageQuery, readPage, toPage } from '../../http/pagination.js';
import { assertBranchAccess, tenantOf } from '../../http/request.js';
import { toApi } from '../../http/serialize.js';
import {
  IdParams,
  IsoDate,
  PaymentMode,
  PositiveMoney,
  Uuid,
  Version,
} from '../../http/validation.js';
import { lockDraftForEdit, registerDocumentActions } from '../documents/actions.js';
import { createIdempotent } from '../documents/idempotency.js';
import {
  LinesInput,
  loadProducts,
  previewResponse,
  priceLines,
  totalsColumns,
} from '../documents/lines.js';
import { CustomerFields, type CustomerInput, resolveCustomer } from '../documents/parties.js';
import { insertReceipt } from '../receipts/receipts.js';
import { type PdfSource, sendDocumentPdf } from '../documents/pdf.js';

/**
 * Sales invoices (GST tax invoices, B2B and B2C).
 *
 *   GET    /v1/sales-invoices?status=&partyId=&branchId=&from=&to=&search=
 *   GET    /v1/sales-invoices/:id
 *   GET    /v1/sales-invoices/:id/pdf
 *   POST   /v1/sales-invoices            create a draft; with post: true it is also posted,
 *                                        and with payment: {...} also paid. All-or-nothing.
 *   PUT    /v1/sales-invoices/:id        replace a draft (send version)
 *   POST   /v1/sales-invoices/:id/post   number it, reduce stock, debit the customer
 *   POST   /v1/sales-invoices/:id/cancel { reason }
 *   DELETE /v1/sales-invoices/:id        drafts only
 *
 * The client sends products and quantities/sizes; the server prices the lines
 * (B2B: wholesale price, B2C: retail price, unless a rate is given) and
 * calculates GST. Send an `Idempotency-Key` header to make creation retry-safe.
 */

const InvoiceFields = z.object({
  ...CustomerFields,
  invoiceDate: IsoDate.optional(),
  dueDate: IsoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: LinesInput,
});

const CreateBody = InvoiceFields.extend({
  post: z.boolean().default(false),
  useAdvance: z.boolean().default(false),
  advanceAmount: PositiveMoney.optional(),
  /** Counter sale: record the payment in the same step (needs post: true). */
  payment: z
    .object({
      mode: PaymentMode,
      amount: PositiveMoney,
      referenceNo: z.string().trim().max(100).optional(),
    })
    .optional(),
}).refine((b) => !b.payment || b.post, {
  message: 'A payment needs post: true',
  path: ['payment'],
});

const UpdateBody = InvoiceFields.extend({ version: Version });

const ListQuery = PageQuery.extend({
  status: z.enum(['draft', 'posted', 'cancelled']).optional(),
  partyId: Uuid.optional(),
  branchId: Uuid.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  /** Invoice number or customer name. */
  search: z.string().trim().optional(),
  /** Only posted invoices with money still to collect (for the receive-payment screen). */
  unpaid: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

type InvoiceInput = CustomerInput & z.infer<typeof InvoiceFields>;

/** Header + priced lines for a draft, from the client's input. */
async function buildInvoice(c: DbClient, input: InvoiceInput) {
  const customer = await resolveCustomer(c, input);
  const products = await loadProducts(
    c,
    input.lines.map((l) => l.productId),
  );
  const { lines, totals } = priceLines(input.lines, products, {
    interState: customer.interState,
    storeSize: true,
    defaultRate: (p) => (customer.supplyType === 'b2b' ? p.wholesale_price : p.retail_price),
  });
  const header = {
    ...customer.columns,
    ...(input.invoiceDate && { invoice_date: input.invoiceDate }),
    due_date: input.dueDate ?? null,
    notes: input.notes ?? null,
    ...totalsColumns(totals),
  };
  return { header, lines };
}

export async function loadSalesInvoice(c: DbClient, id: string): Promise<Record<string, unknown>> {
  const inv = await queryOne(
    c,
    `SELECT i.*, (i.grand_total - i.amount_credited - i.amount_paid)::numeric(14,2) AS balance_due
     FROM erp.sales_invoices i WHERE i.id = $1`,
    [id],
  );
  if (!inv) throw notFound('Invoice');
  const lines = await query(
    c,
    'SELECT * FROM erp.sales_invoice_lines WHERE invoice_id = $1 ORDER BY line_no',
    [id],
  );
  return { ...toApi(inv), lines: lines.map((l) => toApi(l, ['invoice_id'])) };
}

export function registerSalesInvoiceRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/sales-invoices', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = ListQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query(
        c,
        `SELECT id, branch_id, status, invoice_no, invoice_date, due_date, supply_type, party_id, customer_name,
                customer_gstin, grand_total, amount_paid, amount_credited,
                (grand_total - amount_credited - amount_paid)::numeric(14,2) AS balance_due, created_at
         FROM erp.sales_invoices
         WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR party_id = $2)
           AND ($3::uuid IS NULL OR branch_id = $3)
           AND ($4::date IS NULL OR invoice_date >= $4) AND ($5::date IS NULL OR invoice_date <= $5)
           AND ($6::text IS NULL OR invoice_no ILIKE $6 OR customer_name ILIKE $6)
           AND (NOT $9 OR (status = 'posted' AND grand_total - amount_credited - amount_paid > 0))
         ORDER BY invoice_date DESC, created_at DESC
         LIMIT $7 OFFSET $8`,
        [
          q.status ?? null,
          q.partyId ?? null,
          q.branchId ?? null,
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
    '/sales-invoices/:id',
    { preHandler: guards.tenant(Permissions.read) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      return request.tx((c) => loadSalesInvoice(c, id));
    },
  );

  // Prices a bill without saving anything: the billing screen calls this as the
  // user types, so GST is calculated in exactly one place (here).
  app.post(
    '/sales-invoices/preview',
    { preHandler: guards.tenant(Permissions.sell) },
    async (request) => {
      const body = InvoiceFields.parse(request.body);
      assertBranchAccess(tenantOf(request), body.branchId);
      return request.tx(async (c) => {
        const { header, lines } = await buildInvoice(c, body);
        return previewResponse(header, lines);
      });
    },
  );

  app.post(
    '/sales-invoices',
    { preHandler: guards.tenant(Permissions.sell) },
    async (request, reply) => {
      const body = CreateBody.parse(request.body);
      assertBranchAccess(tenantOf(request), body.branchId);

      return createIdempotent(
        request,
        reply,
        'erp.sales_invoices',
        async (c, key) => {
          const { header, lines } = await buildInvoice(c, body);
          const invoice = await insertRow<{ id: string }>(c, 'erp.sales_invoices', {
            ...header,
            idempotency_key: key,
          });
          await insertLines(c, 'erp.sales_invoice_lines', 'invoice_id', invoice.id, lines);
          if (body.post) {
            await c.query('SELECT erp.post_sales_invoice($1)', [invoice.id]);
            if (body.useAdvance && header.party_id) {
              await c.query('SELECT erp.apply_advance_to_invoice($1, $2)', [
                invoice.id,
                body.advanceAmount ?? null,
              ]);
            }
            if (body.payment) {
              await insertReceipt(c, {
                branchId: body.branchId,
                partyId: header.party_id,
                mode: body.payment.mode,
                amount: body.payment.amount,
                referenceNo: body.payment.referenceNo,
                allocations: [{ invoiceId: invoice.id, amount: body.payment.amount }],
                post: true,
              });
            }
          }
          return invoice.id;
        },
        loadSalesInvoice,
      );
    },
  );

  app.put(
    '/sales-invoices/:id',
    { preHandler: guards.tenant(Permissions.sell) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const body = UpdateBody.parse(request.body);
      const auth = tenantOf(request);
      assertBranchAccess(auth, body.branchId);

      return request.tx(async (c) => {
        const current = await lockDraftForEdit(
          c,
          'erp.sales_invoices',
          'Invoice',
          id,
          body.version,
        );
        assertBranchAccess(auth, current.branch_id);
        const { header, lines } = await buildInvoice(c, body);
        const columns = Object.fromEntries(Object.keys(header).map((k) => [k, k]));
        await updateVersioned(
          c,
          'erp.sales_invoices',
          'Invoice',
          id,
          body.version,
          columns,
          header,
        );
        await c.query('DELETE FROM erp.sales_invoice_lines WHERE invoice_id = $1', [id]);
        await insertLines(c, 'erp.sales_invoice_lines', 'invoice_id', id, lines);
        return loadSalesInvoice(c, id);
      });
    },
  );

  app.get(
    '/sales-invoices/:id/pdf',
    { preHandler: guards.tenant(Permissions.read) },
    async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      return sendDocumentPdf(request, reply, async (c) => ({
        doc: (await loadSalesInvoice(c, id)) as unknown as PdfSource['doc'],
        audit: { event: 'invoice.printed', entityType: 'sales_invoice', entityId: id },
      }));
    },
  );

  app.post(
    '/sales-invoices/:id/apply-advance',
    { preHandler: guards.tenant(Permissions.sell) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const body = z.object({ amount: PositiveMoney.optional() }).parse(request.body ?? {});
      return request.tx(async (c) => {
        const row = await queryOne<{ apply_advance_to_invoice: string }>(
          c,
          'SELECT erp.apply_advance_to_invoice($1, $2)',
          [id, body.amount ?? null],
        );
        const invoice = await loadSalesInvoice(c, id);
        return {
          invoiceId: id,
          appliedAmount: row?.apply_advance_to_invoice ?? '0.00',
          invoice,
        };
      });
    },
  );

  registerDocumentActions(app, guards, {
    path: '/sales-invoices',
    table: 'erp.sales_invoices',
    entity: 'Invoice',
    load: loadSalesInvoice,
    post: { fn: 'post_sales_invoice', roles: Permissions.sell },
    cancel: { fn: 'cancel_sales_invoice', roles: Permissions.cancelSales },
    deleteDraft: { roles: Permissions.sell },
  });
}
