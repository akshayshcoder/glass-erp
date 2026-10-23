import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { insertLines, insertRow, query, queryOne } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { AppError, notFound } from '../../http/errors.js';
import { PageQuery, readPage, toPage } from '../../http/pagination.js';
import { assertBranchAccess, tenantOf } from '../../http/request.js';
import { toApi } from '../../http/serialize.js';
import { IdParams, IsoDate, PositiveMoney, Rate, Uuid, decimal } from '../../http/validation.js';
import { registerDocumentActions } from '../documents/actions.js';
import { type PdfSource, sendDocumentPdf } from '../documents/pdf.js';
import { documentTotals, lineAmounts, taxOn } from '../documents/gst.js';
import { createIdempotent } from '../documents/idempotency.js';
import { previewResponse, totalsColumns } from '../documents/lines.js';

/**
 * Credit notes against a posted sales invoice.
 *
 *   reason = sales_return       goods came back: lines need qty (rate defaults to the invoice rate);
 *                               restock: true puts saleable goods back into stock
 *   reason = rate_difference |
 *            discount | deficiency | other    value correction: lines give `amount` (taxable value)
 *
 *   GET    /v1/credit-notes?invoiceId=&partyId=&status=
 *   GET    /v1/credit-notes/:id
 *   POST   /v1/credit-notes            draft (post: true to post immediately)
 *   POST   /v1/credit-notes/:id/post
 *   POST   /v1/credit-notes/:id/cancel { reason }
 *   DELETE /v1/credit-notes/:id        drafts only
 *
 * Customer, place of supply, HSN and GST rate are copied from the invoice. The
 * database enforces the GST rules: same customer, returned qty <= sold,
 * credited <= invoice value, issued by 30 November after the financial year.
 */

const Reason = z.enum(['sales_return', 'rate_difference', 'discount', 'deficiency', 'other']);

const CreateBody = z
  .object({
    invoiceId: Uuid,
    reason: Reason,
    restock: z.boolean().default(false),
    noteDate: IsoDate.optional(),
    remarks: z.string().trim().max(2000).optional(),
    lines: z
      .array(
        z.object({
          productId: Uuid,
          qty: decimal(3, { positive: true }).optional(),
          rate: Rate.optional(),
          /** Taxable value, for value-only notes. */
          amount: PositiveMoney.optional(),
        }),
      )
      .min(1)
      .max(500),
    post: z.boolean().default(false),
  })
  .superRefine((b, ctx) => {
    b.lines.forEach((l, i) => {
      if (b.reason === 'sales_return' && l.qty === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Returned quantity is required',
          path: ['lines', i, 'qty'],
        });
      }
      if (b.reason !== 'sales_return' && l.amount === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'Amount is required',
          path: ['lines', i, 'amount'],
        });
      }
    });
    if (b.restock && b.reason !== 'sales_return') {
      ctx.addIssue({
        code: 'custom',
        message: 'Only sales returns can be restocked',
        path: ['restock'],
      });
    }
  });

const ListQuery = PageQuery.extend({
  invoiceId: Uuid.optional(),
  partyId: Uuid.optional(),
  status: z.enum(['draft', 'posted', 'cancelled']).optional(),
});

async function loadCreditNote(c: DbClient, id: string): Promise<Record<string, unknown>> {
  const cn = await queryOne(
    c,
    `SELECT n.*, i.invoice_no,
            coalesce((SELECT pp.customer_type FROM erp.parties pp WHERE pp.id = n.party_id), 'walk_in') AS customer_type
     FROM erp.credit_notes n JOIN erp.sales_invoices i ON i.id = n.invoice_id
     WHERE n.id = $1`,
    [id],
  );
  if (!cn) throw notFound('Credit note');
  const lines = await query(
    c,
    'SELECT * FROM erp.credit_note_lines WHERE credit_note_id = $1 ORDER BY line_no',
    [id],
  );
  return { ...toApi(cn), lines: lines.map((l) => toApi(l, ['credit_note_id'])) };
}

async function buildCreditNote(c: DbClient, b: z.infer<typeof CreateBody>) {
  const inv = await queryOne<{
    id: string;
    status: string;
    branch_id: string;
    party_id: string | null;
    customer_name: string;
    customer_gstin: string | null;
    place_of_supply: string;
    seller_state_code: string;
  }>(c, 'SELECT * FROM erp.sales_invoices WHERE id = $1', [b.invoiceId]);
  if (!inv) throw new AppError(422, 'INVALID_REFERENCE', 'Invoice not found');
  if (inv.status !== 'posted')
    throw new AppError(409, 'INVALID_STATE', `The invoice is ${inv.status}`);

  // What was sold on the invoice, per product (first line's rate, HSN, unit).
  const sold = new Map(
    (
      await query<{
        product_id: string;
        description: string;
        hsn_code: string;
        unit_code: string;
        rate: string;
        gst_rate: string;
      }>(
        c,
        `SELECT DISTINCT ON (product_id) product_id, description, hsn_code, unit_code, rate, gst_rate
         FROM erp.sales_invoice_lines WHERE invoice_id = $1 ORDER BY product_id, line_no`,
        [inv.id],
      )
    ).map((r) => [r.product_id, r]),
  );

  const interState = inv.place_of_supply !== inv.seller_state_code;
  const lines = b.lines.map((l) => {
    const s = sold.get(l.productId);
    if (!s)
      throw new AppError(
        422,
        'BUSINESS_RULE',
        'A credit note line has a product that is not on the invoice',
      );
    const qty = l.qty ?? '0.000';
    const rate = l.rate ?? (l.qty ? s.rate : '0');
    const amounts = l.amount
      ? taxOn(l.amount, s.gst_rate, interState)
      : lineAmounts(qty, rate, '0', s.gst_rate, interState);
    return {
      product_id: l.productId,
      description: s.description,
      hsn_code: s.hsn_code,
      unit_code: s.unit_code,
      qty,
      rate,
      taxable_value: amounts.taxableValue,
      gst_rate: s.gst_rate,
      cgst_amount: amounts.cgstAmount,
      sgst_amount: amounts.sgstAmount,
      igst_amount: amounts.igstAmount,
    };
  });
  const totals = documentTotals(
    lines.map((l) => ({
      taxableValue: l.taxable_value,
      cgstAmount: l.cgst_amount,
      sgstAmount: l.sgst_amount,
      igstAmount: l.igst_amount,
    })),
  );

  const header = {
    branch_id: inv.branch_id,
    invoice_id: inv.id,
    party_id: inv.party_id,
    reason: b.reason,
    restock: b.restock,
    customer_name: inv.customer_name,
    customer_gstin: inv.customer_gstin,
    place_of_supply: inv.place_of_supply,
    seller_state_code: inv.seller_state_code,
    remarks: b.remarks ?? null,
    ...(b.noteDate && { note_date: b.noteDate }),
    ...totalsColumns(totals),
  };
  return { header, lines };
}

export function registerCreditNoteRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/credit-notes', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = ListQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query(
        c,
        `SELECT n.id, n.branch_id, n.status, n.note_no, n.note_date, n.invoice_id, i.invoice_no, n.party_id,
                n.customer_name, n.reason, n.restock, n.grand_total,
                coalesce((SELECT pp.customer_type FROM erp.parties pp WHERE pp.id = n.party_id), 'walk_in') AS customer_type
         FROM erp.credit_notes n JOIN erp.sales_invoices i ON i.id = n.invoice_id
         WHERE ($1::uuid IS NULL OR n.invoice_id = $1) AND ($2::uuid IS NULL OR n.party_id = $2)
           AND ($3::text IS NULL OR n.status = $3)
         ORDER BY n.note_date DESC, n.created_at DESC
         LIMIT $4 OFFSET $5`,
        [q.invoiceId ?? null, q.partyId ?? null, q.status ?? null, page.limit + 1, page.offset],
      ),
    );
    const result = toPage(rows, page);
    return { items: result.items.map((r) => toApi(r)), nextPageToken: result.nextPageToken };
  });

  app.get('/credit-notes/:id', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    return request.tx((c) => loadCreditNote(c, id));
  });

  // Prices a credit note without saving it (live totals on the return screen).
  app.post(
    '/credit-notes/preview',
    { preHandler: guards.tenant(Permissions.creditNotes) },
    async (request) => {
      const body = CreateBody.parse(request.body);
      return request.tx(async (c) => {
        const { header, lines } = await buildCreditNote(c, body);
        assertBranchAccess(tenantOf(request), header.branch_id);
        return previewResponse(header, lines);
      });
    },
  );

  app.post(
    '/credit-notes',
    { preHandler: guards.tenant(Permissions.creditNotes) },
    async (request, reply) => {
      const body = CreateBody.parse(request.body);
      const auth = tenantOf(request);
      return createIdempotent(
        request,
        reply,
        'erp.credit_notes',
        async (c, key) => {
          const { header, lines } = await buildCreditNote(c, body);
          assertBranchAccess(auth, header.branch_id);
          const note = await insertRow<{ id: string }>(c, 'erp.credit_notes', {
            ...header,
            idempotency_key: key,
          });
          await insertLines(c, 'erp.credit_note_lines', 'credit_note_id', note.id, lines);
          if (body.post) await c.query('SELECT erp.post_credit_note($1)', [note.id]);
          return note.id;
        },
        loadCreditNote,
      );
    },
  );

  // The GST credit note document for the customer.
  app.get(
    '/credit-notes/:id/pdf',
    { preHandler: guards.tenant(Permissions.read) },
    async (request, reply) => {
      const { id } = IdParams.parse(request.params);
      return sendDocumentPdf(request, reply, async (c) => {
        const n = (await loadCreditNote(c, id)) as Record<string, unknown> & {
          status: string;
          noteNo: string | null;
          noteDate: string;
          invoiceNo: string | null;
          reason: string;
          remarks: string | null;
        };
        const suffix =
          n.status === 'draft' ? ' (DRAFT)' : n.status === 'cancelled' ? ' (CANCELLED)' : '';
        return {
          doc: {
            ...n,
            invoiceNo: n.noteNo,
            invoiceDate: n.noteDate,
            dueDate: null,
            customerPhone: null,
            billingAddress: null,
            shippingAddress: null,
            notes: n.remarks,
            reverseCharge: false,
          } as unknown as PdfSource['doc'],
          kind: {
            title: `CREDIT NOTE${suffix}`,
            numberLabel: 'Credit note No.',
            details: [
              ['Against invoice', n.invoiceNo ?? ''],
              ['Reason', n.reason.replace(/_/g, ' ')],
            ],
            footer: 'This is a computer-generated credit note.',
          },
          audit: { event: 'credit_note.printed', entityType: 'credit_note', entityId: id },
        };
      });
    },
  );

  registerDocumentActions(app, guards, {
    path: '/credit-notes',
    table: 'erp.credit_notes',
    entity: 'Credit note',
    load: loadCreditNote,
    post: { fn: 'post_credit_note', roles: Permissions.creditNotes },
    cancel: { fn: 'cancel_credit_note', roles: Permissions.creditNotes },
    deleteDraft: { roles: Permissions.creditNotes },
  });
}
