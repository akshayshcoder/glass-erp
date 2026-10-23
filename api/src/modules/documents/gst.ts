import { Decimal } from 'decimal.js';
import { AppError } from '../../http/errors.js';

/*
 * GST line and document maths. Pure functions, exact decimals, no I/O.
 *
 * Rules (they match the CHECK constraints in the database):
 *   taxable  = round2(qty x rate - discount)
 *   tax      = taxable x gstRate / 100
 *   same state  -> CGST = SGST = round2(tax / 2)
 *   other state -> IGST = round2(tax)
 *   document total is rounded to the nearest rupee; the difference is round_off.
 * Rates are always EXCLUSIVE of GST.
 */

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

export type SizeUnit = 'mm' | 'cm' | 'inch' | 'ft' | 'm';
export type Measure = 'quantity' | 'area' | 'length' | 'weight';

/** Size of glass / aluminium as typed at the counter. */
export interface SizeInput {
  unit: SizeUnit;
  width?: string;
  height?: string;
  length?: string;
  pieces: number;
}

/** One unit of the size, expressed in feet and in metres. */
const FEET: Record<SizeUnit, Decimal> = {
  mm: new Decimal(1).div(304.8),
  cm: new Decimal(1).div(30.48),
  inch: new Decimal(1).div(12),
  ft: new Decimal(1),
  m: new Decimal(1).div(0.3048),
};
const METRES: Record<SizeUnit, Decimal> = {
  mm: new Decimal('0.001'),
  cm: new Decimal('0.01'),
  inch: new Decimal('0.0254'),
  ft: new Decimal('0.3048'),
  m: new Decimal(1),
};

/** Which length unit an area / length product is billed in. */
const AREA_UNITS: Record<string, Record<SizeUnit, Decimal>> = { SQFT: FEET, SQM: METRES };
const LENGTH_UNITS: Record<string, Record<SizeUnit, Decimal>> = { RFT: FEET, MTR: METRES };

const rule = (message: string) => new AppError(422, 'BUSINESS_RULE', message);

/**
 * Billed quantity from a size, in the product's unit.
 *   area   (SQFT/SQM): width x height x pieces
 *   length (RFT/MTR):  length x pieces
 * Rounded to 3 decimals (the database's quantity scale).
 */
export function quantityFromSize(measure: Measure, unitCode: string, size: SizeInput): string {
  const pieces = new Decimal(size.pieces);
  if (measure === 'area') {
    const factor = AREA_UNITS[unitCode];
    if (!factor) throw rule(`Area products must be sold in SQFT or SQM, not ${unitCode}`);
    if (!size.width || !size.height) throw rule('Width and height are required for this product');
    const f = factor[size.unit];
    return new Decimal(size.width)
      .mul(f)
      .mul(new Decimal(size.height).mul(f))
      .mul(pieces)
      .toFixed(3);
  }
  if (measure === 'length') {
    const factor = LENGTH_UNITS[unitCode];
    if (!factor) throw rule(`Length products must be sold in RFT or MTR, not ${unitCode}`);
    if (!size.length) throw rule('Length is required for this product');
    return new Decimal(size.length).mul(factor[size.unit]).mul(pieces).toFixed(3);
  }
  throw rule('This product is not sold by size; enter a quantity');
}

export interface LineAmounts {
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
}

/** Taxable value and GST for one line. */
export function lineAmounts(
  qty: string,
  rate: string,
  discount: string,
  gstRate: string,
  interState: boolean,
): LineAmounts {
  const gross = new Decimal(qty).mul(rate);
  const taxable = gross.minus(discount).toDecimalPlaces(2);
  if (taxable.isNegative()) throw rule('Discount is larger than the line amount');
  return taxOn(taxable, gstRate, interState);
}

/** GST on an already known taxable value (e.g. a value-only credit note). */
export function taxOn(taxable: Decimal.Value, gstRate: string, interState: boolean): LineAmounts {
  const t = new Decimal(taxable).toDecimalPlaces(2);
  const tax = t.mul(gstRate).div(100);
  const half = tax.div(2).toDecimalPlaces(2);
  return {
    taxableValue: t.toFixed(2),
    cgstAmount: interState ? '0.00' : half.toFixed(2),
    sgstAmount: interState ? '0.00' : half.toFixed(2),
    igstAmount: interState ? tax.toDecimalPlaces(2).toFixed(2) : '0.00',
  };
}

export interface DocumentTotals extends LineAmounts {
  roundOff: string;
  grandTotal: string;
}

/** Sums the lines and rounds the total to the nearest rupee. */
export function documentTotals(lines: LineAmounts[]): DocumentTotals {
  const sum = (key: keyof LineAmounts) => lines.reduce((s, l) => s.plus(l[key]), new Decimal(0));
  const taxable = sum('taxableValue');
  const cgst = sum('cgstAmount');
  const sgst = sum('sgstAmount');
  const igst = sum('igstAmount');
  const exact = taxable.plus(cgst).plus(sgst).plus(igst);
  const grand = exact.toDecimalPlaces(0);
  return {
    taxableValue: taxable.toFixed(2),
    cgstAmount: cgst.toFixed(2),
    sgstAmount: sgst.toFixed(2),
    igstAmount: igst.toFixed(2),
    roundOff: grand.minus(exact).toFixed(2),
    grandTotal: grand.toFixed(2),
  };
}

/** "36 x 48 inch x 2 pcs" for the printed line description. */
export function describeSize(size: SizeInput): string {
  const unit = size.unit === 'inch' ? 'in' : size.unit;
  const n = (v?: string) => new Decimal(v ?? 0).toString(); // "36.000" -> "36", "36.500" -> "36.5"
  const dims = size.length
    ? `${n(size.length)} ${unit}`
    : `${n(size.width)} x ${n(size.height)} ${unit}`;
  return `${dims} x ${size.pieces} pc${size.pieces === 1 ? '' : 's'}`;
}
