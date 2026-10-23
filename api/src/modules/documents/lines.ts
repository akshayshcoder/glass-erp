import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { query } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { toApi } from '../../http/serialize.js';
import { Money, Rate, Uuid, decimal } from '../../http/validation.js';
import {
  type DocumentTotals,
  type Measure,
  type SizeInput,
  describeSize,
  documentTotals,
  lineAmounts,
  quantityFromSize,
} from './gst.js';

/*
 * Line items shared by invoices, quotations and purchase bills.
 *
 * The client sends WHAT is sold (product, quantity or size, optionally rate and
 * discount). The server fills in HSN, GST rate, unit and description from the
 * product master and calculates every amount. Clients never send tax amounts.
 */

export const SizeSchema = z.object({
  unit: z.enum(['mm', 'cm', 'inch', 'ft', 'm']),
  width: decimal(3, { positive: true }).optional(),
  height: decimal(3, { positive: true }).optional(),
  length: decimal(3, { positive: true }).optional(),
  pieces: z.number().int().positive().default(1),
});

export const LineInput = z
  .object({
    productId: Uuid,
    /** Billed quantity in the product's unit. Either this or `size`. */
    qty: decimal(3, { positive: true }).optional(),
    /** Glass / aluminium size; the quantity is calculated from it. */
    size: SizeSchema.optional(),
    /** Exclusive of GST. Default: the product's price for this kind of document. */
    rate: Rate.optional(),
    discount: Money.optional(),
    description: z.string().trim().min(1).optional(),
  })
  .refine((l) => (l.qty === undefined) !== (l.size === undefined), {
    message: 'Give either qty or size',
    path: ['qty'],
  });

export type LineInput = z.infer<typeof LineInput>;

export const LinesInput = z.array(LineInput).min(1, 'At least one line').max(500);

export interface ProductRow {
  id: string;
  name: string;
  hsn_code: string;
  gst_rate: string;
  unit_code: string;
  measure: Measure;
  thickness_mm: string | null;
  attributes: Record<string, unknown>;
  retail_price: string;
  wholesale_price: string;
  purchase_price: string;
  is_active: boolean;
}

function describeProductSpec(p: ProductRow): string {
  const parts: string[] = [];
  const len = typeof p.attributes?.length === 'string' ? p.attributes.length.trim() : '';
  const lenUnit =
    typeof p.attributes?.lengthUnit === 'string' && p.attributes.lengthUnit.trim()
      ? p.attributes.lengthUnit.trim()
      : 'inch';
  if (len) parts.push(`${len} ${lenUnit}`);
  if (p.thickness_mm) parts.push(`${new Decimal(p.thickness_mm).toString()} mm`);
  return parts.join(' × ');
}

/** Loads the products used on a document; unknown or retired products are rejected. */
export async function loadProducts(c: DbClient, ids: string[]): Promise<Map<string, ProductRow>> {
  const rows = await query<ProductRow>(
    c,
    `SELECT id, name, hsn_code, gst_rate, unit_code, measure, thickness_mm, attributes,
            retail_price, wholesale_price, purchase_price, is_active
     FROM erp.products WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) throw new AppError(422, 'INVALID_REFERENCE', `Product ${id} not found`);
    if (!p.is_active)
      throw new AppError(422, 'BUSINESS_RULE', `Product "${p.name}" is no longer active`);
  }
  return byId;
}

/** A priced line, keyed by database column. */
export interface PricedLine {
  product_id: string;
  description: string;
  hsn_code: string;
  unit_code: string;
  size_unit?: string | null;
  width?: string | null;
  height?: string | null;
  length?: string | null;
  pieces?: number | null;
  qty: string;
  rate: string;
  discount_amount: string;
  taxable_value: string;
  gst_rate: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
}

export interface PricingOptions {
  interState: boolean;
  /** Price used when a line gives no rate. */
  defaultRate: (p: ProductRow) => string;
  /** Whether the line table has size columns (purchase lines don't). */
  storeSize: boolean;
}

export function priceLines(
  inputs: LineInput[],
  products: Map<string, ProductRow>,
  opts: PricingOptions,
): { lines: PricedLine[]; totals: DocumentTotals } {
  const lines = inputs.map((input) => {
    const p = products.get(input.productId)!;
    const size = input.size as SizeInput | undefined;
    const qty = size ? quantityFromSize(p.measure, p.unit_code, size) : input.qty!;
    const rate = input.rate ?? opts.defaultRate(p);
    const discount = input.discount ?? '0.00';
    const amounts = lineAmounts(qty, rate, discount, p.gst_rate, opts.interState);
    const spec = describeProductSpec(p);
    const baseName =
      spec && !p.name.toLowerCase().includes(spec.toLowerCase()) ? `${p.name} [${spec}]` : p.name;
    const description =
      input.description ?? (size ? `${baseName} (${describeSize(size)})` : baseName);

    const line: PricedLine = {
      product_id: p.id,
      description,
      hsn_code: p.hsn_code,
      unit_code: p.unit_code,
      qty,
      rate,
      discount_amount: discount,
      taxable_value: amounts.taxableValue,
      gst_rate: p.gst_rate,
      cgst_amount: amounts.cgstAmount,
      sgst_amount: amounts.sgstAmount,
      igst_amount: amounts.igstAmount,
    };
    if (opts.storeSize) {
      Object.assign(line, {
        size_unit: size?.unit ?? null,
        width: size?.width ?? null,
        height: size?.height ?? null,
        length: size?.length ?? null,
        pieces: size?.pieces ?? null,
      });
    }
    return line;
  });

  const totals = documentTotals(
    lines.map((l) => ({
      taxableValue: l.taxable_value,
      cgstAmount: l.cgst_amount,
      sgstAmount: l.sgst_amount,
      igstAmount: l.igst_amount,
    })),
  );
  return { lines, totals };
}

/** Header columns for a document's totals. */
export function totalsColumns(t: DocumentTotals) {
  return {
    taxable_value: t.taxableValue,
    cgst_amount: t.cgstAmount,
    sgst_amount: t.sgstAmount,
    igst_amount: t.igstAmount,
    round_off: t.roundOff,
    grand_total: t.grandTotal,
  };
}

/**
 * Response of a /preview endpoint: the priced document as it WOULD be saved,
 * with each line's total. Nothing is written to the database.
 */
export function previewResponse(header: Record<string, unknown>, lines: object[]) {
  return {
    ...toApi(header),
    lines: lines.map((line, i) => {
      const l = line as Record<string, string>;
      const total = new Decimal(l.taxable_value!)
        .plus(l.cgst_amount!)
        .plus(l.sgst_amount!)
        .plus(l.igst_amount!);
      return toApi({ line_no: i + 1, ...line, line_total: total.toFixed(2) });
    }),
  };
}
