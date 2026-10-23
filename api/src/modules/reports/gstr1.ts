import { query, queryOne } from '../../db/sql.js';
import type { Column, Sheet } from './excel.js';
import type { DbClient } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';

/*
 * GSTR-1 (outward supplies) for one branch (GSTIN) and one month.
 *
 * Sections, as the return needs them:
 *   b2b    invoices to registered customers (with GSTIN), invoice-wise, rate-wise
 *   b2cl   inter-state invoices to unregistered customers above Rs 1,00,000, invoice-wise
 *   b2cs   all other B2C sales, summarised by place of supply + rate, NET of their credit notes
 *   cdnr   credit notes to registered customers
 *   cdnur  credit notes to unregistered customers against B2CL invoices
 *   hsn    HSN summary, split into B2B and B2C (net of credit notes)
 *   docs   documents issued in the month: number range, total, cancelled
 *
 * Only POSTED documents count (a bill cancelled before filing is excluded and
 * shown as cancelled in the document summary). All sums are done by
 * PostgreSQL on NUMERIC, so they are exact.
 *
 * The accountant should open the JSON / Excel in the GST offline tool and
 * review it before uploading: this is a preparation aid, not an auto-filer.
 */

/** Unregistered inter-state invoices above this value are B2CL (since Aug 2024). */
export const B2CL_THRESHOLD = '100000';

/** UQC as written in the GST offline tool. */
const UQC_NAMES: Record<string, string> = {
  PCS: 'PIECES',
  NOS: 'NUMBERS',
  SQF: 'SQUARE FEET',
  SQM: 'SQUARE METERS',
  MTR: 'METERS',
  KGS: 'KILOGRAMS',
  BOX: 'BOX',
  SET: 'SETS',
  PRS: 'PAIRS',
  ROL: 'ROLLS',
  BDL: 'BUNDLES',
  OTH: 'OTHERS',
};
export const uqcLabel = (code: string) => `${code}-${UQC_NAMES[code] ?? 'OTHERS'}`;

export interface TaxRow {
  rate: string;
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
}

export interface Gstr1Invoice {
  id: string;
  number: string;
  date: string;
  value: string;
  pos: string;
  reverseCharge: boolean;
  customerGstin: string | null;
  customerName: string;
  items: TaxRow[];
}

export interface Gstr1Note extends Gstr1Invoice {
  invoiceNumber: string;
  invoiceDate: string;
}

export interface Gstr1 {
  gstin: string;
  branchName: string;
  period: string; // YYYY-MM
  b2b: Gstr1Invoice[];
  b2cl: Gstr1Invoice[];
  b2cs: (TaxRow & { pos: string; supplyType: 'INTRA' | 'INTER' })[];
  cdnr: Gstr1Note[];
  cdnur: Gstr1Note[];
  hsn: { b2b: HsnRow[]; b2c: HsnRow[] };
  docs: DocRange[];
  /** Totals per section for the summary screen. */
  totals: Record<string, TaxRow & { count: number }>;
}

export interface HsnRow extends TaxRow {
  hsn: string;
  description: string;
  uqc: string;
  qty: string;
  value: string;
}

export interface DocRange {
  kind: 'Invoices for outward supply' | 'Credit Note';
  from: string;
  to: string;
  total: number;
  cancelled: number;
}

// ---- SQL fragments ----------------------------------------------------------------

/** $2 = first day of the month. */
const IN_MONTH = (col: string) => `${col} >= $2::date AND ${col} < ($2::date + interval '1 month')`;
const B2CL = `(i.customer_gstin IS NULL AND i.place_of_supply <> i.seller_state_code AND i.grand_total > ${B2CL_THRESHOLD})`;

interface InvoiceRateRow {
  id: string;
  number: string;
  date: string;
  value: string;
  pos: string;
  reverse_charge: boolean;
  customer_gstin: string | null;
  customer_name: string;
  rate: string;
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
  invoice_number?: string;
  invoice_date?: string;
}

/** Group rate-wise rows (ordered by document) into documents with items. */
function byDocument(rows: InvoiceRateRow[]): (Gstr1Invoice & Partial<Gstr1Note>)[] {
  const docs = new Map<string, Gstr1Invoice & Partial<Gstr1Note>>();
  for (const r of rows) {
    let doc = docs.get(r.id);
    if (!doc) {
      doc = {
        id: r.id,
        number: r.number,
        date: r.date,
        value: r.value,
        pos: r.pos,
        reverseCharge: r.reverse_charge,
        customerGstin: r.customer_gstin,
        customerName: r.customer_name,
        items: [],
        ...(r.invoice_number && { invoiceNumber: r.invoice_number, invoiceDate: r.invoice_date }),
      };
      docs.set(r.id, doc);
    }
    doc.items.push({ rate: r.rate, taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst });
  }
  return [...docs.values()];
}

const TAX_SUMS = `
  sum(l.taxable_value)::numeric(14,2) AS taxable, sum(l.igst_amount)::numeric(14,2) AS igst,
  sum(l.cgst_amount)::numeric(14,2) AS cgst, sum(l.sgst_amount)::numeric(14,2) AS sgst`;

export async function buildGstr1(c: DbClient, branchId: string, period: string): Promise<Gstr1> {
  const branch = await queryOne<{ gstin: string | null; name: string }>(
    c,
    'SELECT gstin, name FROM erp.branches WHERE id = $1',
    [branchId],
  );
  if (!branch) throw new AppError(422, 'INVALID_REFERENCE', 'Branch not found');
  if (!branch.gstin) {
    throw new AppError(
      422,
      'BUSINESS_RULE',
      'This branch has no GSTIN, so it does not file GSTR-1',
    );
  }
  const params = [branchId, `${period}-01`];

  const invoiceRows = (where: string) =>
    query<InvoiceRateRow>(
      c,
      `SELECT i.id, i.invoice_no AS number, i.invoice_date AS date, i.grand_total AS value,
              i.place_of_supply AS pos, i.reverse_charge, i.customer_gstin, i.customer_name,
              l.gst_rate AS rate, ${TAX_SUMS}
       FROM erp.sales_invoices i JOIN erp.sales_invoice_lines l ON l.invoice_id = i.id
       WHERE i.branch_id = $1 AND i.status = 'posted' AND ${IN_MONTH('i.invoice_date')} AND ${where}
       GROUP BY i.id, l.gst_rate
       ORDER BY i.invoice_no, l.gst_rate`,
      params,
    );

  const noteRows = (where: string) =>
    query<InvoiceRateRow>(
      c,
      `SELECT n.id, n.note_no AS number, n.note_date AS date, n.grand_total AS value,
              n.place_of_supply AS pos, false AS reverse_charge, n.customer_gstin, n.customer_name,
              i.invoice_no AS invoice_number, i.invoice_date AS invoice_date,
              l.gst_rate AS rate, ${TAX_SUMS}
       FROM erp.credit_notes n
       JOIN erp.credit_note_lines l ON l.credit_note_id = n.id
       JOIN erp.sales_invoices i ON i.id = n.invoice_id
       WHERE n.branch_id = $1 AND n.status = 'posted' AND ${IN_MONTH('n.note_date')} AND ${where}
       GROUP BY n.id, i.id, l.gst_rate
       ORDER BY n.note_no, l.gst_rate`,
      params,
    );

  const b2b = byDocument(await invoiceRows('i.customer_gstin IS NOT NULL'));
  const b2cl = byDocument(await invoiceRows(B2CL));
  const cdnr = byDocument(await noteRows('n.customer_gstin IS NOT NULL')) as Gstr1Note[];
  const cdnur = byDocument(await noteRows(`n.customer_gstin IS NULL AND ${B2CL}`)) as Gstr1Note[];

  // B2CS: small B2C invoices minus credit notes on them, by place of supply + rate.
  const b2cs = await query<TaxRow & { pos: string; supply_type: 'INTRA' | 'INTER' }>(
    c,
    `WITH lines AS (
       SELECT i.place_of_supply AS pos, i.seller_state_code AS seller, l.gst_rate AS rate,
              l.taxable_value AS taxable, l.igst_amount AS igst, l.cgst_amount AS cgst, l.sgst_amount AS sgst
       FROM erp.sales_invoices i JOIN erp.sales_invoice_lines l ON l.invoice_id = i.id
       WHERE i.branch_id = $1 AND i.status = 'posted' AND ${IN_MONTH('i.invoice_date')}
         AND i.customer_gstin IS NULL AND NOT ${B2CL}
       UNION ALL
       SELECT n.place_of_supply, n.seller_state_code, l.gst_rate,
              -l.taxable_value, -l.igst_amount, -l.cgst_amount, -l.sgst_amount
       FROM erp.credit_notes n
       JOIN erp.credit_note_lines l ON l.credit_note_id = n.id
       JOIN erp.sales_invoices i ON i.id = n.invoice_id
       WHERE n.branch_id = $1 AND n.status = 'posted' AND ${IN_MONTH('n.note_date')}
         AND n.customer_gstin IS NULL AND NOT ${B2CL})
     SELECT pos, CASE WHEN pos = seller THEN 'INTRA' ELSE 'INTER' END AS supply_type, rate,
            sum(taxable)::numeric(14,2) AS taxable, sum(igst)::numeric(14,2) AS igst,
            sum(cgst)::numeric(14,2) AS cgst, sum(sgst)::numeric(14,2) AS sgst
     FROM lines GROUP BY pos, seller, rate
     HAVING sum(taxable) <> 0
     ORDER BY pos, rate`,
    params,
  );

  // HSN summary, B2B and B2C separately, net of credit notes.
  const hsnRows = await query<HsnRow & { b2b: boolean }>(
    c,
    `WITH lines AS (
       SELECT i.customer_gstin IS NOT NULL AS b2b, l.hsn_code, l.product_id, l.unit_code, l.gst_rate,
              l.qty, l.taxable_value, l.igst_amount, l.cgst_amount, l.sgst_amount
       FROM erp.sales_invoices i JOIN erp.sales_invoice_lines l ON l.invoice_id = i.id
       WHERE i.branch_id = $1 AND i.status = 'posted' AND ${IN_MONTH('i.invoice_date')}
       UNION ALL
       SELECT n.customer_gstin IS NOT NULL, l.hsn_code, l.product_id, l.unit_code, l.gst_rate,
              -l.qty, -l.taxable_value, -l.igst_amount, -l.cgst_amount, -l.sgst_amount
       FROM erp.credit_notes n JOIN erp.credit_note_lines l ON l.credit_note_id = n.id
       WHERE n.branch_id = $1 AND n.status = 'posted' AND ${IN_MONTH('n.note_date')})
     SELECT x.b2b, x.hsn_code AS hsn, min(p.name) AS description, u.gst_uqc AS uqc,
            x.gst_rate AS rate, sum(x.qty)::numeric(14,3) AS qty,
            sum(x.taxable_value)::numeric(14,2) AS taxable, sum(x.igst_amount)::numeric(14,2) AS igst,
            sum(x.cgst_amount)::numeric(14,2) AS cgst, sum(x.sgst_amount)::numeric(14,2) AS sgst,
            sum(x.taxable_value + x.igst_amount + x.cgst_amount + x.sgst_amount)::numeric(14,2) AS value
     FROM lines x JOIN erp.units u ON u.code = x.unit_code JOIN erp.products p ON p.id = x.product_id
     GROUP BY x.b2b, x.hsn_code, u.gst_uqc, x.gst_rate
     HAVING sum(x.taxable_value) <> 0 OR sum(x.qty) <> 0
     ORDER BY x.hsn_code, x.gst_rate`,
    params,
  );
  const strip = ({ b2b: _b2b, ...row }: HsnRow & { b2b: boolean }) => row;

  // Document summary: every numbered document dated in the month, per series.
  const docRows = await query<{
    kind: 'invoice' | 'note';
    from: string;
    to: string;
    total: number;
    cancelled: number;
  }>(
    c,
    `SELECT 'invoice' AS kind, min(invoice_no) AS from, max(invoice_no) AS to, count(*)::int AS total,
            count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
     FROM erp.sales_invoices
     WHERE branch_id = $1 AND invoice_no IS NOT NULL AND ${IN_MONTH('invoice_date')}
     GROUP BY financial_year
     UNION ALL
     SELECT 'note', min(note_no), max(note_no), count(*)::int,
            count(*) FILTER (WHERE status = 'cancelled')::int
     FROM erp.credit_notes
     WHERE branch_id = $1 AND note_no IS NOT NULL AND ${IN_MONTH('note_date')}
     GROUP BY financial_year`,
    params,
  );

  const sectionTotals = await query<{ section: string; count: number } & TaxRow>(
    c,
    `SELECT section, count(DISTINCT id)::int AS count, NULL AS rate,
            coalesce(sum(taxable), 0)::numeric(14,2) AS taxable, coalesce(sum(igst), 0)::numeric(14,2) AS igst,
            coalesce(sum(cgst), 0)::numeric(14,2) AS cgst, coalesce(sum(sgst), 0)::numeric(14,2) AS sgst
     FROM (
       SELECT CASE WHEN i.customer_gstin IS NOT NULL THEN 'b2b' WHEN ${B2CL} THEN 'b2cl' ELSE 'b2cs' END AS section,
              i.id, i.taxable_value AS taxable, i.igst_amount AS igst, i.cgst_amount AS cgst, i.sgst_amount AS sgst
       FROM erp.sales_invoices i
       WHERE i.branch_id = $1 AND i.status = 'posted' AND ${IN_MONTH('i.invoice_date')}
       UNION ALL
       SELECT CASE WHEN n.customer_gstin IS NOT NULL THEN 'cdnr' WHEN ${B2CL} THEN 'cdnur' ELSE 'b2cs_credit' END,
              n.id, n.taxable_value, n.igst_amount, n.cgst_amount, n.sgst_amount
       FROM erp.credit_notes n JOIN erp.sales_invoices i ON i.id = n.invoice_id
       WHERE n.branch_id = $1 AND n.status = 'posted' AND ${IN_MONTH('n.note_date')}
     ) s GROUP BY section`,
    params,
  );

  return {
    gstin: branch.gstin,
    branchName: branch.name,
    period,
    b2b,
    b2cl,
    b2cs: b2cs.map(({ supply_type, ...r }) => ({ ...r, supplyType: supply_type })),
    cdnr,
    cdnur,
    hsn: {
      b2b: hsnRows.filter((r) => r.b2b).map(strip),
      b2c: hsnRows.filter((r) => !r.b2b).map(strip),
    },
    docs: docRows.map((d) => ({
      kind: d.kind === 'invoice' ? 'Invoices for outward supply' : 'Credit Note',
      from: d.from,
      to: d.to,
      total: d.total,
      cancelled: d.cancelled,
    })),
    totals: Object.fromEntries(sectionTotals.map(({ section, ...t }) => [section, t])),
  };
}

// ---- GST portal JSON ----------------------------------------------------------------

/** "2026-10-19" -> "19-10-2026" */
const portalDate = (d: string) => d.split('-').reverse().join('-');
/** The portal expects JSON numbers. Values are exact 2-decimal strings from SQL. */
const n = (v: string) => Number(v);
const rateNum = (rate: string) => Math.round(Number(rate) * 100) + 1;

const itms = (items: TaxRow[], interOnly = false) =>
  items.map((t) => ({
    num: rateNum(t.rate),
    itm_det: {
      txval: n(t.taxable),
      rt: n(t.rate),
      iamt: n(t.igst),
      ...(!interOnly && { camt: n(t.cgst), samt: n(t.sgst) }),
      csamt: 0,
    },
  }));

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of rows) map.set(key(r), [...(map.get(key(r)) ?? []), r]);
  return map;
}

/** GSTR-1 in the JSON layout of the GST offline tool / portal upload. */
export function toPortalJson(g: Gstr1) {
  const [year, month] = g.period.split('-');
  const hsn = (rows: HsnRow[]) =>
    rows.map((r, i) => ({
      num: i + 1,
      hsn_sc: r.hsn,
      desc: r.description.slice(0, 30),
      uqc: r.uqc,
      qty: n(r.qty),
      rt: n(r.rate),
      txval: n(r.taxable),
      iamt: n(r.igst),
      camt: n(r.cgst),
      samt: n(r.sgst),
      csamt: 0,
    }));

  return {
    gstin: g.gstin,
    fp: `${month}${year}`,
    b2b: [...groupBy(g.b2b, (i) => i.customerGstin!)].map(([ctin, invoices]) => ({
      ctin,
      inv: invoices.map((i) => ({
        inum: i.number,
        idt: portalDate(i.date),
        val: n(i.value),
        pos: i.pos,
        rchrg: i.reverseCharge ? 'Y' : 'N',
        inv_typ: 'R',
        itms: itms(i.items),
      })),
    })),
    b2cl: [...groupBy(g.b2cl, (i) => i.pos)].map(([pos, invoices]) => ({
      pos,
      inv: invoices.map((i) => ({
        inum: i.number,
        idt: portalDate(i.date),
        val: n(i.value),
        itms: itms(i.items, true),
      })),
    })),
    b2cs: g.b2cs.map((r) => ({
      sply_ty: r.supplyType,
      pos: r.pos,
      typ: 'OE',
      rt: n(r.rate),
      txval: n(r.taxable),
      iamt: n(r.igst),
      camt: n(r.cgst),
      samt: n(r.sgst),
      csamt: 0,
    })),
    cdnr: [...groupBy(g.cdnr, (x) => x.customerGstin!)].map(([ctin, notes]) => ({
      ctin,
      nt: notes.map((x) => ({
        ntty: 'C',
        nt_num: x.number,
        nt_dt: portalDate(x.date),
        val: n(x.value),
        pos: x.pos,
        rchrg: 'N',
        inv_typ: 'R',
        itms: itms(x.items),
      })),
    })),
    cdnur: g.cdnur.map((x) => ({
      typ: 'B2CL',
      ntty: 'C',
      nt_num: x.number,
      nt_dt: portalDate(x.date),
      val: n(x.value),
      pos: x.pos,
      itms: itms(x.items, true),
    })),
    hsn: { hsn_b2b: hsn(g.hsn.b2b), hsn_b2c: hsn(g.hsn.b2c) },
    doc_issue: {
      doc_det: [
        ['Invoices for outward supply', 1],
        ['Credit Note', 5],
      ]
        .map(([kind, docNum]) => ({
          doc_num: docNum,
          docs: g.docs
            .filter((d) => d.kind === kind)
            .map((d, i) => ({
              num: i + 1,
              from: d.from,
              to: d.to,
              totnum: d.total,
              cancel: d.cancelled,
              net_issue: d.total - d.cancelled,
            })),
        }))
        .filter((d) => d.docs.length > 0),
    },
  };
}

// ---- Excel (sheet names and columns follow the GST offline tool template) ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-19" -> "19-Oct-2026" (offline tool date format) */
const excelDate = (d: string) => {
  const [y, m, day] = d.split('-');
  return `${day}-${MONTHS[Number(m) - 1]}-${y}`;
};

export function toWorkbookSheets(g: Gstr1, stateNames: Record<string, string>): Sheet[] {
  const pos = (code: string) => `${code}-${stateNames[code] ?? ''}`;
  const rateRows = <T extends Gstr1Invoice>(docs: T[], extra: (d: T) => Record<string, unknown>) =>
    docs.flatMap((d) =>
      d.items.map((t) => ({ ...extra(d), rate: t.rate, taxable: t.taxable, cess: '0' })),
    );
  const money = (key: string, header: string): Column => ({
    key,
    header,
    type: 'money',
    width: 14,
  });
  const taxCols: Column[] = [
    { key: 'rate', header: 'Rate', type: 'rate', width: 8 },
    money('taxable', 'Taxable Value'),
    money('cess', 'Cess Amount'),
  ];
  const hsnSheet = (name: string, rows: HsnRow[]): Sheet => ({
    name,
    columns: [
      { key: 'hsn', header: 'HSN', width: 10 },
      { key: 'description', header: 'Description', width: 30 },
      { key: 'uqc', header: 'UQC', width: 18 },
      { key: 'qty', header: 'Total Quantity', type: 'qty' },
      money('value', 'Total Value'),
      { key: 'rate', header: 'Rate', type: 'rate', width: 8 },
      money('taxable', 'Taxable Value'),
      money('igst', 'Integrated Tax Amount'),
      money('cgst', 'Central Tax Amount'),
      money('sgst', 'State/UT Tax Amount'),
      money('cess', 'Cess Amount'),
    ],
    rows: rows.map((r) => ({ ...r, uqc: uqcLabel(r.uqc), cess: '0' })),
  });

  const sectionNames: Record<string, string> = {
    b2b: 'B2B invoices',
    b2cl: 'B2C large (inter-state above Rs 1 lakh)',
    b2cs: 'B2C small',
    b2cs_credit: 'Credit notes on B2C small (netted in b2cs)',
    cdnr: 'Credit notes - registered',
    cdnur: 'Credit notes - unregistered (B2CL)',
  };

  return [
    {
      name: 'summary',
      columns: [
        { key: 'section', header: 'Section', width: 42 },
        { key: 'count', header: 'Documents', type: 'int' },
        money('taxable', 'Taxable Value'),
        money('igst', 'IGST'),
        money('cgst', 'CGST'),
        money('sgst', 'SGST'),
      ],
      rows: Object.entries(g.totals).map(([section, t]) => ({
        ...t,
        section: sectionNames[section] ?? section,
      })),
    },
    {
      name: 'b2b',
      columns: [
        { key: 'gstin', header: 'GSTIN/UIN of Recipient', width: 18 },
        { key: 'name', header: 'Receiver Name', width: 28 },
        { key: 'number', header: 'Invoice Number', width: 18 },
        { key: 'date', header: 'Invoice date' },
        money('value', 'Invoice Value'),
        { key: 'pos', header: 'Place Of Supply', width: 20 },
        { key: 'rc', header: 'Reverse Charge' },
        { key: 'applicable', header: 'Applicable % of Tax Rate' },
        { key: 'type', header: 'Invoice Type' },
        { key: 'ecom', header: 'E-Commerce GSTIN' },
        ...taxCols,
      ],
      rows: rateRows(g.b2b, (i) => ({
        gstin: i.customerGstin,
        name: i.customerName,
        number: i.number,
        date: excelDate(i.date),
        value: i.value,
        pos: pos(i.pos),
        rc: i.reverseCharge ? 'Y' : 'N',
        type: 'Regular B2B',
      })),
    },
    {
      name: 'b2cl',
      columns: [
        { key: 'number', header: 'Invoice Number', width: 18 },
        { key: 'date', header: 'Invoice date' },
        money('value', 'Invoice Value'),
        { key: 'pos', header: 'Place Of Supply', width: 20 },
        { key: 'applicable', header: 'Applicable % of Tax Rate' },
        ...taxCols,
        { key: 'ecom', header: 'E-Commerce GSTIN' },
      ],
      rows: rateRows(g.b2cl, (i) => ({
        number: i.number,
        date: excelDate(i.date),
        value: i.value,
        pos: pos(i.pos),
      })),
    },
    {
      name: 'b2cs',
      columns: [
        { key: 'type', header: 'Type' },
        { key: 'pos', header: 'Place Of Supply', width: 20 },
        { key: 'applicable', header: 'Applicable % of Tax Rate' },
        ...taxCols,
        { key: 'ecom', header: 'E-Commerce GSTIN' },
      ],
      rows: g.b2cs.map((r) => ({
        type: 'OE',
        pos: pos(r.pos),
        rate: r.rate,
        taxable: r.taxable,
        cess: '0',
      })),
    },
    {
      name: 'cdnr',
      columns: [
        { key: 'gstin', header: 'GSTIN/UIN of Recipient', width: 18 },
        { key: 'name', header: 'Receiver Name', width: 28 },
        { key: 'number', header: 'Note Number', width: 18 },
        { key: 'date', header: 'Note Date' },
        { key: 'noteType', header: 'Note Type' },
        { key: 'pos', header: 'Place Of Supply', width: 20 },
        { key: 'rc', header: 'Reverse Charge' },
        { key: 'supplyType', header: 'Note Supply Type' },
        money('value', 'Note Value'),
        { key: 'applicable', header: 'Applicable % of Tax Rate' },
        ...taxCols,
      ],
      rows: rateRows(g.cdnr, (x) => ({
        gstin: x.customerGstin,
        name: x.customerName,
        number: x.number,
        date: excelDate(x.date),
        noteType: 'C',
        pos: pos(x.pos),
        rc: 'N',
        supplyType: 'Regular B2B',
        value: x.value,
      })),
    },
    {
      name: 'cdnur',
      columns: [
        { key: 'urType', header: 'UR Type' },
        { key: 'number', header: 'Note Number', width: 18 },
        { key: 'date', header: 'Note Date' },
        { key: 'noteType', header: 'Note Type' },
        { key: 'pos', header: 'Place Of Supply', width: 20 },
        money('value', 'Note Value'),
        { key: 'applicable', header: 'Applicable % of Tax Rate' },
        ...taxCols,
      ],
      rows: rateRows(g.cdnur, (x) => ({
        urType: 'B2CL',
        number: x.number,
        date: excelDate(x.date),
        noteType: 'C',
        pos: pos(x.pos),
        value: x.value,
      })),
    },
    hsnSheet('hsn(b2b)', g.hsn.b2b),
    hsnSheet('hsn(b2c)', g.hsn.b2c),
    {
      name: 'docs',
      columns: [
        { key: 'kind', header: 'Nature of Document', width: 30 },
        { key: 'from', header: 'Sr. No. From', width: 18 },
        { key: 'to', header: 'Sr. No. To', width: 18 },
        { key: 'total', header: 'Total Number', type: 'int' },
        { key: 'cancelled', header: 'Cancelled', type: 'int' },
      ],
      rows: g.docs.map((d) => ({ ...d })),
    },
  ];
}
