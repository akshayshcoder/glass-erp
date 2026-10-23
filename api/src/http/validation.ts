import { Decimal } from 'decimal.js';
import { z } from 'zod';

/*
 * Reusable field schemas. API conventions:
 *   * JSON keys are camelCase; the database is snake_case.
 *   * Money and quantities are DECIMAL STRINGS ("1180.00"), never JSON numbers,
 *     so no client or server ever rounds them through a float. Numbers are
 *     accepted on input for convenience and normalised.
 *   * Dates are 'YYYY-MM-DD'.
 */

export const Uuid = z.uuid();

export const Gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');

export const StateCode = z.string().regex(/^[0-9]{2}$/, 'State code must be 2 digits, e.g. 07');
export const Pincode = z.string().regex(/^[1-9][0-9]{5}$/, 'Invalid PIN code');
export const Phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, 'Invalid phone number');
export const Email = z.email().trim().toLowerCase();
export const HsnCode = z
  .string()
  .regex(/^[0-9]{4}([0-9]{2}){0,2}$/, 'HSN must be 4, 6 or 8 digits');
export const IsoDate = z.iso.date();
export const NonEmpty = z.string().trim().min(1, 'Required');

/** Decimal with at most `scale` places, returned as a normalised string. */
export function decimal(scale: number, opts: { min?: number; positive?: boolean } = {}) {
  return z.union([z.string(), z.number()]).transform((value, ctx) => {
    let d: Decimal;
    try {
      d = new Decimal(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Must be a number' });
      return z.NEVER;
    }
    if (!d.isFinite() || d.decimalPlaces() > scale) {
      ctx.addIssue({ code: 'custom', message: `At most ${scale} decimal places` });
      return z.NEVER;
    }
    if (opts.positive && d.lte(0)) {
      ctx.addIssue({ code: 'custom', message: 'Must be greater than 0' });
      return z.NEVER;
    }
    if (opts.min !== undefined && d.lt(opts.min)) {
      ctx.addIssue({ code: 'custom', message: `Must be at least ${opts.min}` });
      return z.NEVER;
    }
    return d.toFixed(scale);
  });
}

export const Money = decimal(2, { min: 0 });
export const PositiveMoney = decimal(2, { positive: true });
export const PaymentMode = z.enum(['cash', 'upi', 'card', 'bank_transfer', 'cheque']);
export const SignedMoney = decimal(2);
export const Quantity = decimal(3);
export const Rate = decimal(4, { min: 0 });
export const GstRate = decimal(2, { min: 0 }).refine((v) => Number(v) <= 100, 'At most 100');

/** Optimistic locking: every update must send the version it was based on. */
export const Version = z.number().int().positive();

export const IdParams = z.object({ id: Uuid });
