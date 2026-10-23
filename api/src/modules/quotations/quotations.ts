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
import { IdParams, IsoDate, Uuid, Version } from '../../http/validation.js';
import { lockDraftForEdit, registerDocumentActions } from '../documents/actions.js';
import { type PdfSource, sendDocumentPdf } from '../documents/pdf.js';
import { LinesInput, loadProducts, priceLines, totalsColumns } from '../documents/lines.js';
import { CustomerFields, resolveCustomer } from '../documents/parties.js';
import { loadSalesInvoice } from '../sales-invoices/sales-invoices.js';

/**
 * Quotations / estimates for customers (no stock, ledger or GST effect).
 *
 *   draft --issue--> issued --> accepted | rejected --convert--> converted (a DRAFT invoice)
 *
 *   GET    /v1/quotations?status=&partyId=&search=
 *   GET    /v1/quotations/:id
 *   POST   /v1/quotations                draft
 *   PUT    /v1/quotations/:id            replace a draft (send version)
 *   POST   /v1/quotations/:id/issue      gives it a number; frozen from now on
 *   POST   /v1/quotations/:id/accept | /reject
 *   POST   /v1/quotations/:id/convert    -> the new draft invoice (adjust cut sizes, then post it)
 *   POST   /v1/quotations/:id/cancel     { reason }
 *   DELETE /v1/quotations/:id            drafts only
 */

const QuoteFields = z.object({
  ...CustomerFields,
  quoteDate: IsoDate.optional(),
  validUntil: IsoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Delivery, fitting and payment terms printed on the quotation. */
  terms: z.string().trim().max(4000).optional(),
  lines: LinesInput,
});
const UpdateBody = QuoteFields.extend({ version: Version });

const ListQuery = PageQuery.extend({
  status: z.enum(['draft', 'issued', 'accepted', 'rejected', 'converted', 'cancelled']).optional(),
  partyId: Uuid.optional(),
  search: z.string().trim().optional(),
});

async function buildQuotation(c: DbClient, input: z.infer<typeof QuoteFields>) {
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
    ...(input.quoteDate && { quote_date: input.quoteDate }),
    valid_until: input.validUntil ?? null,
    notes: input.notes ?? null,
    terms: input.terms ?? null,
    ...totalsColumns(totals),
  };
  return { header, lines };
}

async function loadQuotation(c: DbClient, id: string): Promise<Record<string, unknown>> {
  const qt = await queryOne(
    c,
    `SELECT q.*, (q.valid_until IS NOT NULL AND q.valid_until < erp.today()
                  AND q.status IN ('issued', 'accepted')) AS is_expired,
            coalesce((SELECT pp.customer_type FROM erp.parties pp WHERE pp.id = q.party_id), 'walk_in') AS customer_type
     FROM erp.quotations q WHERE q.id = $1`,
    [id],
  );
  if (!qt) throw notFound('Quotation');
  const lines = await query(
    c,
    'SELECT * FROM erp.quotation_lines WHERE quotation_id = $1 ORDER BY line_no',
    [id],
  );
  return { ...toApi(qt), lines: lines.map((l) => toApi(l, ['quotation_id'])) };
}

export function registerQuotationRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/quotations', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = ListQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query(
        c,
        `SELECT id, branch_id, status, quote_no, quote_date, valid_until, party_id, customer_name, grand_total,
                invoice_id, created_at,
                coalesce((SELECT pp.customer_type FROM erp.parties pp WHERE pp.id = party_id), 'walk_in') AS customer_type
         FROM erp.quotations
         WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR party_id = $2)
           AND ($3::text IS NULL OR quote_no ILIKE $3 OR customer_name ILIKE $3)
         ORDER BY quote_date DESC, created_at DESC
         LIMIT $4 OFFSET $5`,
        [
          q.status ?? null,
          q.partyId ?? null,
          q.search ? containsPattern(q.search) : null,
          page.limit + 1,
          page.offset,
        ],
      ),
    );
    const result = toPage(rows, page);
    return { items: result.items.map((r) => toApi(r)), nextPageToken: result.nextPageToken };
  });

  app.get('/quotations/:id', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    return request.tx((c) => loadQuotation(c, id));
  });

  app.post(
    '/quotations',
    { preHandler: guards.tenant(Permissions.quote) },
    async (request, reply) => {
      const body = QuoteFields.parse(request.body);
      assertBranchAccess(tenantOf(request), body.branchId);
      // No idempotency key: a duplicate quotation costs nothing and is simply deleted.
      const quote = await request.tx(async (c) => {
        const { header, lines } = await buildQuotation(c, body);
        const row = await insertRow<{ id: string }>(c, 'erp.quotations', header);
        await insertLines(c, 'erp.quotation_lines', 'quotation_id', row.id, lines);
        return loadQuotation(c, row.id);
      });
      return reply.status(201).send(quote);
    },
  );

  app.put('/quotations/:id', { preHandler: guards.tenant(Permissions.quote) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = UpdateBody.parse(request.body);
    const auth = tenantOf(request);
    assertBranchAccess(auth, body.branchId);
    return request.tx(async (c) => {
      const current = await lockDraftForEdit(c, 'erp.quotations', 'Quotation', id, body.version);
      assertBranchAccess(auth, current.branch_id);
      const { header, lines } = await buildQuotation(c, body);
      const columns = Object.fromEntries(Object.keys(header).map((k) => [k, k]));
      await updateVersioned(c, 'erp.quotations', 'Quotation', id, body.version, columns, header);
      await c.query('DELETE FROM erp.quotation_lines WHERE quotation_id = $1', [id]);
      await insertLines(c, 'erp.quotation_lines', 'quotation_id', id, lines);
      return loadQuotation(c, id);
    });
  });

  // Issue / accept / reject / convert: thin wrappers over the database functions.
  const action = (path: string, run: (c: DbClient, id: string) => Promise<unknown>) =>
    app.post(
      `/quotations/:id/${path}`,
      { preHandler: guards.tenant(Permissions.quote) },
      async (request) => {
        const { id } = IdParams.parse(request.params);
        return request.tx(async (c) => {
          const row = await queryOne<{ branch_id: string }>(
            c,
            'SELECT branch_id FROM erp.quotations WHERE id = $1',
            [id],
          );
          if (!row) throw notFound('Quotation');
          assertBranchAccess(tenantOf(request), row.branch_id);
          return run(c, id);
        });
      },
    );

  action('issue', async (c, id) => {
    await c.query('SELECT erp.issue_quotation($1)', [id]);
    return loadQuotation(c, id);
  });
  action('accept', async (c, id) => {
    await c.query('SELECT erp.set_quotation_response($1, true)', [id]);
    return loadQuotation(c, id);
  });
  action('reject', async (c, id) => {
    await c.query('SELECT erp.set_quotation_response($1, false)', [id]);
    return loadQuotation(c, id);
  });
  action('convert', async (c, id) => {
    const row = await queryOne<{ invoice_id: string }>(
      c,
      'SELECT erp.convert_quotation_to_invoice($1) AS invoice_id',
      [id],
    );
    return loadSalesInvoice(c, row!.invoice_id);
  });

  // Printable quotation to give the customer (same layout as the tax invoice).
  app.get(
    '/quotations/:id/pdf',
    { preHandler: guards.tenant(Permissions.read) },
    async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      return sendDocumentPdf(request, reply, async (c) => {
        const q = (await loadQuotation(c, id)) as Record<string, unknown> & {
          status: string;
          quoteNo: string | null;
          quoteDate: string;
          validUntil: string | null;
          terms: string | null;
        };
        const suffix =
          q.status === 'draft' ? ' (DRAFT)' : q.status === 'cancelled' ? ' (CANCELLED)' : '';
        return {
          doc: {
            ...q,
            invoiceNo: q.quoteNo,
            invoiceDate: q.quoteDate,
            dueDate: null,
            reverseCharge: false,
          } as unknown as PdfSource['doc'],
          kind: {
            title: `QUOTATION${suffix}`,
            numberLabel: 'Quotation No.',
            details: q.validUntil ? [['Valid until', q.validUntil]] : [],
            terms: q.terms,
            footer: 'This is a quotation, not a tax invoice.',
          },
          audit: { event: 'quotation.printed', entityType: 'quotation', entityId: id },
        };
      });
    },
  );

  registerDocumentActions(app, guards, {
    path: '/quotations',
    table: 'erp.quotations',
    entity: 'Quotation',
    load: loadQuotation,
    cancel: { fn: 'cancel_quotation', roles: Permissions.quote },
    deleteDraft: { roles: Permissions.quote },
  });
}
