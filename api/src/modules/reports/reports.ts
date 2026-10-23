import { Decimal } from 'decimal.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { query } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { IsoDate, Uuid } from '../../http/validation.js';
import { type Column, buildWorkbook, sendXlsx } from './excel.js';
import { buildGstr1, toPortalJson, toWorkbookSheets } from './gstr1.js';

/**
 * Reports. Read-only. Roles: owner, admin, manager, accountant.
 *
 *   GET /v1/reports/gstr1?branchId&period=YYYY-MM[&format=portal|xlsx]   GST return data / downloads
 *   GET /v1/reports/sales?from&to&groupBy=day|month|product|customer[&branchId][&format=xlsx]
 *   GET /v1/reports/receivables[?branchId][&format=xlsx]                 who owes us, by age
 *   GET /v1/reports/payables[?branchId][&format=xlsx]                    whom we owe, by age
 *   GET /v1/reports/stock-value[?branchId][&format=xlsx]
 *   GET /v1/reports/purchases?from&to[&branchId][&format=xlsx]           purchase register (ITC)
 *
 * Tabular reports return { title, columns, rows, totals } so the web app can
 * show any report with one table component; ?format=xlsx downloads the same
 * table as Excel. Every download is written to the audit log.
 */

interface Report {
  title: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  totals: Record<string, string>;
}

const Format = z.enum(['json', 'xlsx']).default('json');
const Period = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/, "Period must be 'YYYY-MM'");
const Range = z.object({ from: IsoDate, to: IsoDate, branchId: Uuid.optional(), format: Format });

/** Exact sums of the money / quantity columns, for the totals row. */
function totalsOf(rows: Record<string, unknown>[], columns: Column[]): Record<string, string> {
  const totals: Record<string, string> = {};
  for (const c of columns) {
    if (c.type !== 'money' && c.type !== 'int') continue;
    const sum = rows.reduce<Decimal>(
      (s, r) => s.plus((r[c.key] as string | number | null) ?? 0),
      new Decimal(0),
    );
    totals[c.key] = c.type === 'int' ? sum.toFixed(0) : sum.toFixed(2);
  }
  return totals;
}

async function respond(
  request: FastifyRequest,
  reply: FastifyReply,
  format: 'json' | 'xlsx',
  fileName: string,
  build: (c: DbClient) => Promise<Omit<Report, 'totals'>>,
) {
  const report = await request.tx(async (c) => {
    const r = await build(c);
    if (format === 'xlsx') {
      await c.query(`SELECT audit.log_event('report.exported', 'report', $1, '{}')`, [fileName]);
    }
    return { ...r, totals: totalsOf(r.rows, r.columns) };
  });
  if (format === 'json') return report;
  const totalRow = { ...report.totals, [report.columns[0]!.key]: 'Total' };
  const buffer = await buildWorkbook([
    { name: report.title, columns: report.columns, rows: [...report.rows, totalRow] },
  ]);
  return sendXlsx(reply, buffer, fileName);
}

const money = (key: string, header: string): Column => ({ key, header, type: 'money' });

export function registerReportRoutes(app: FastifyInstance, { guards }: AppContext) {
  const guard = { preHandler: guards.tenant(Permissions.reports) };

  // ---- GSTR-1 -------------------------------------------------------------------
  app.get('/reports/gstr1', guard, async (request, reply) => {
    const q = z
      .object({
        branchId: Uuid,
        period: Period,
        format: z.enum(['json', 'portal', 'xlsx']).default('json'),
      })
      .parse(request.query);

    const { gstr1, states } = await request.tx(async (c) => {
      const data = await buildGstr1(c, q.branchId, q.period);
      if (q.format !== 'json') {
        await c.query(`SELECT audit.log_event('report.exported', 'gstr1', $1, $2)`, [
          q.branchId,
          JSON.stringify({ period: q.period, format: q.format }),
        ]);
      }
      const stateRows = await query<{ code: string; name: string }>(
        c,
        'SELECT code, name FROM erp.states',
      );
      return { gstr1: data, states: Object.fromEntries(stateRows.map((s) => [s.code, s.name])) };
    });

    const [year, month] = q.period.split('-');
    const fileName = `GSTR1_${gstr1.gstin}_${month}${year}`;
    if (q.format === 'portal') {
      return reply
        .type('application/json')
        .header('content-disposition', `attachment; filename="${fileName}.json"`)
        .send(JSON.stringify(toPortalJson(gstr1), null, 2));
    }
    if (q.format === 'xlsx') {
      return sendXlsx(reply, await buildWorkbook(toWorkbookSheets(gstr1, states)), fileName);
    }
    return gstr1;
  });

  // ---- Sales summary -------------------------------------------------------------
  app.get('/reports/sales', guard, async (request, reply) => {
    const q = Range.extend({
      groupBy: z.enum(['day', 'month', 'product', 'customer']).default('day'),
    }).parse(request.query);
    const params = [q.from, q.to, q.branchId ?? null];
    const where = (alias: string, dateCol: string) =>
      `${alias}.status = 'posted' AND ${alias}.${dateCol} BETWEEN $1 AND $2
       AND ($3::uuid IS NULL OR ${alias}.branch_id = $3)`;

    return respond(request, reply, q.format, `Sales_${q.groupBy}_${q.from}_${q.to}`, async (c) => {
      if (q.groupBy === 'product') {
        // Net of returns / credit notes. Cost uses the product's LAST purchase
        // price, so the margin is an estimate.
        const rows = await query<Record<string, unknown>>(
          c,
          `WITH lines AS (
             SELECT l.product_id, l.qty, l.taxable_value
             FROM erp.sales_invoices i JOIN erp.sales_invoice_lines l ON l.invoice_id = i.id
             WHERE ${where('i', 'invoice_date')}
             UNION ALL
             SELECT l.product_id, -l.qty, -l.taxable_value
             FROM erp.credit_notes n JOIN erp.credit_note_lines l ON l.credit_note_id = n.id
             WHERE ${where('n', 'note_date')})
           SELECT p.sku, p.name, p.unit_code AS unit, sum(x.qty)::numeric(14,3) AS qty,
                  sum(x.taxable_value)::numeric(14,2) AS sales,
                  (sum(x.qty) * p.purchase_price)::numeric(14,2) AS cost,
                  (sum(x.taxable_value) - sum(x.qty) * p.purchase_price)::numeric(14,2) AS margin,
                  CASE WHEN sum(x.taxable_value) > 0
                       THEN round((sum(x.taxable_value) - sum(x.qty) * p.purchase_price) * 100 / sum(x.taxable_value), 1)
                  END AS margin_pct
           FROM lines x JOIN erp.products p ON p.id = x.product_id
           GROUP BY p.id ORDER BY sales DESC`,
          params,
        );
        return {
          title: 'Sales by product',
          columns: [
            { key: 'sku', header: 'SKU' },
            { key: 'name', header: 'Product', width: 30 },
            { key: 'unit', header: 'Unit' },
            { key: 'qty', header: 'Qty sold', type: 'qty' },
            money('sales', 'Sales (before GST)'),
            money('cost', 'Est. cost'),
            money('margin', 'Est. margin'),
            { key: 'margin_pct', header: 'Margin %', type: 'rate' },
          ],
          rows,
        };
      }

      if (q.groupBy === 'customer') {
        const rows = await query<Record<string, unknown>>(
          c,
          `SELECT coalesce(min(p.name), 'Walk-in customers') AS customer, min(p.gstin) AS gstin,
                  count(*)::int AS invoices, sum(i.taxable_value)::numeric(14,2) AS taxable,
                  sum(i.grand_total)::numeric(14,2) AS total,
                  sum(i.amount_credited)::numeric(14,2) AS credited,
                  sum(i.grand_total - i.amount_credited - i.amount_paid)::numeric(14,2) AS due
           FROM erp.sales_invoices i LEFT JOIN erp.parties p ON p.id = i.party_id
           WHERE ${where('i', 'invoice_date')}
           GROUP BY i.party_id ORDER BY total DESC`,
          params,
        );
        return {
          title: 'Sales by customer',
          columns: [
            { key: 'customer', header: 'Customer', width: 30 },
            { key: 'gstin', header: 'GSTIN', width: 18 },
            { key: 'invoices', header: 'Bills', type: 'int' },
            money('taxable', 'Taxable'),
            money('total', 'Billed (incl. GST)'),
            money('credited', 'Credit notes'),
            money('due', 'Still due'),
          ],
          rows,
        };
      }

      // By day or month: invoices and credit notes side by side.
      const bucket = (col: string) =>
        q.groupBy === 'month' ? `to_char(${col}, 'YYYY-MM')` : `${col}::text`;
      const rows = await query<Record<string, unknown>>(
        c,
        `WITH s AS (
           SELECT ${bucket('i.invoice_date')} AS period, count(*)::int AS invoices,
                  sum(i.taxable_value) AS taxable, sum(i.cgst_amount + i.sgst_amount + i.igst_amount) AS gst,
                  sum(i.grand_total) AS total
           FROM erp.sales_invoices i WHERE ${where('i', 'invoice_date')} GROUP BY 1),
         cn AS (
           SELECT ${bucket('n.note_date')} AS period, sum(n.grand_total) AS credit_notes
           FROM erp.credit_notes n WHERE ${where('n', 'note_date')} GROUP BY 1)
         SELECT coalesce(s.period, cn.period) AS period, coalesce(s.invoices, 0) AS invoices,
                coalesce(s.taxable, 0)::numeric(14,2) AS taxable, coalesce(s.gst, 0)::numeric(14,2) AS gst,
                coalesce(s.total, 0)::numeric(14,2) AS total,
                coalesce(cn.credit_notes, 0)::numeric(14,2) AS credit_notes,
                (coalesce(s.total, 0) - coalesce(cn.credit_notes, 0))::numeric(14,2) AS net
         FROM s FULL JOIN cn ON cn.period = s.period
         ORDER BY 1`,
        params,
      );
      return {
        title: q.groupBy === 'month' ? 'Sales by month' : 'Sales by day',
        columns: [
          { key: 'period', header: q.groupBy === 'month' ? 'Month' : 'Date' },
          { key: 'invoices', header: 'Bills', type: 'int' },
          money('taxable', 'Taxable'),
          money('gst', 'GST'),
          money('total', 'Billed (incl. GST)'),
          money('credit_notes', 'Credit notes'),
          money('net', 'Net sales'),
        ],
        rows,
      };
    });
  });

  // ---- Ageing: receivables and payables -----------------------------------------
  const ageingColumns = (party: string): Column[] => [
    { key: 'name', header: party, width: 30 },
    { key: 'bills', header: 'Open bills', type: 'int' },
    { key: 'oldest', header: 'Oldest bill' },
    money('d0_30', '0-30 days'),
    money('d31_60', '31-60 days'),
    money('d61_90', '61-90 days'),
    money('d90', 'Over 90 days'),
    money('total', 'Total due'),
  ];
  const ageingSums = (dateCol: string) => `
    count(*)::int AS bills, min(${dateCol})::text AS oldest,
    coalesce(sum(due) FILTER (WHERE erp.today() - ${dateCol} <= 30), 0)::numeric(14,2) AS d0_30,
    coalesce(sum(due) FILTER (WHERE erp.today() - ${dateCol} BETWEEN 31 AND 60), 0)::numeric(14,2) AS d31_60,
    coalesce(sum(due) FILTER (WHERE erp.today() - ${dateCol} BETWEEN 61 AND 90), 0)::numeric(14,2) AS d61_90,
    coalesce(sum(due) FILTER (WHERE erp.today() - ${dateCol} > 90), 0)::numeric(14,2) AS d90,
    sum(due)::numeric(14,2) AS total`;
  const BranchQuery = z.object({ branchId: Uuid.optional(), format: Format });

  app.get('/reports/receivables', guard, async (request, reply) => {
    const q = BranchQuery.parse(request.query);
    return respond(request, reply, q.format, 'Receivables', async (c) => ({
      title: 'Receivables',
      columns: ageingColumns('Customer'),
      rows: await query<Record<string, unknown>>(
        c,
        `SELECT party_id, coalesce(min(p.name), 'Walk-in: ' || min(customer_name)) AS name, ${ageingSums('invoice_date')}
         FROM (SELECT i.*, i.grand_total - i.amount_credited - i.amount_paid AS due
               FROM erp.sales_invoices i
               WHERE i.status = 'posted' AND ($1::uuid IS NULL OR i.branch_id = $1)) x
         LEFT JOIN erp.parties p ON p.id = x.party_id
         WHERE due > 0
         GROUP BY party_id, CASE WHEN party_id IS NULL THEN customer_name END
         ORDER BY total DESC`,
        [q.branchId ?? null],
      ),
    }));
  });

  app.get('/reports/payables', guard, async (request, reply) => {
    const q = BranchQuery.parse(request.query);
    return respond(request, reply, q.format, 'Payables', async (c) => ({
      title: 'Payables',
      columns: ageingColumns('Supplier'),
      rows: await query<Record<string, unknown>>(
        c,
        `SELECT supplier_id AS party_id, min(supplier_name) AS name, ${ageingSums('entry_date')}
         FROM (SELECT b.*, b.grand_total - b.amount_paid AS due
               FROM erp.purchase_bills b
               WHERE b.status = 'posted' AND ($1::uuid IS NULL OR b.branch_id = $1)) x
         WHERE due > 0
         GROUP BY supplier_id ORDER BY total DESC`,
        [q.branchId ?? null],
      ),
    }));
  });

  // ---- Stock value -----------------------------------------------------------------
  app.get('/reports/stock-value', guard, async (request, reply) => {
    const q = BranchQuery.parse(request.query);
    return respond(request, reply, q.format, 'Stock_value', async (c) => ({
      title: 'Stock value',
      columns: [
        { key: 'sku', header: 'SKU' },
        { key: 'name', header: 'Product', width: 30 },
        { key: 'kind', header: 'Kind' },
        { key: 'qty', header: 'In stock', type: 'qty' },
        { key: 'unit', header: 'Unit' },
        { key: 'rate', header: 'Last purchase rate', type: 'rate' },
        money('value', 'Value'),
      ],
      rows: await query<Record<string, unknown>>(
        c,
        `SELECT p.sku, p.name, p.kind, sum(b.qty)::numeric(14,3) AS qty, p.unit_code AS unit,
                p.purchase_price AS rate, (sum(b.qty) * p.purchase_price)::numeric(14,2) AS value
         FROM erp.stock_balances b JOIN erp.products p ON p.id = b.product_id
         WHERE ($1::uuid IS NULL OR b.branch_id = $1)
         GROUP BY p.id HAVING sum(b.qty) <> 0
         ORDER BY value DESC, p.name`,
        [q.branchId ?? null],
      ),
    }));
  });

  // ---- Purchase register (for input tax credit) -------------------------------------
  app.get('/reports/purchases', guard, async (request, reply) => {
    const q = Range.parse(request.query);
    return respond(request, reply, q.format, `Purchase_register_${q.from}_${q.to}`, async (c) => ({
      title: 'Purchase register',
      columns: [
        { key: 'doc_no', header: 'Our no.', width: 16 },
        { key: 'entry_date', header: 'Received' },
        { key: 'supplier_name', header: 'Supplier', width: 28 },
        { key: 'supplier_gstin', header: 'Supplier GSTIN', width: 18 },
        { key: 'supplier_invoice_no', header: 'Supplier bill', width: 16 },
        { key: 'supplier_invoice_date', header: 'Bill date' },
        money('taxable_value', 'Taxable'),
        money('igst_amount', 'IGST'),
        money('cgst_amount', 'CGST'),
        money('sgst_amount', 'SGST'),
        money('grand_total', 'Total'),
        { key: 'itc', header: 'ITC' },
      ],
      rows: await query<Record<string, unknown>>(
        c,
        `SELECT doc_no, entry_date::text, supplier_name, supplier_gstin, supplier_invoice_no,
                supplier_invoice_date::text, taxable_value, igst_amount, cgst_amount, sgst_amount, grand_total,
                CASE WHEN itc_eligible THEN 'Yes' ELSE 'No' END AS itc
         FROM erp.purchase_bills
         WHERE status = 'posted' AND entry_date BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR branch_id = $3)
         ORDER BY entry_date, doc_no`,
        [q.from, q.to, q.branchId ?? null],
      ),
    }));
  });
}
