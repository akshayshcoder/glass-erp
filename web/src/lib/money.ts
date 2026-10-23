/*
 * Exact money arithmetic for the few UI conveniences that need it (splitting a
 * payment across bills). Amounts become integer paise (BigInt), so there is no
 * float rounding. GST/tax is never calculated here: that is the API's job.
 */

/** "1304.5" -> 130450n. Invalid or empty input -> 0n. */
export function toPaise(value: string | null | undefined): bigint {
  const v = (value ?? '').trim();
  const m = /^(-)?(\d*)(?:\.(\d{0,2}))?\d*$/.exec(v);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return 0n;
  const rupees = BigInt(m[2] || '0');
  const paise = BigInt(((m[3] ?? '') + '00').slice(0, 2));
  const total = rupees * 100n + paise;
  return m[1] ? -total : total;
}

/** 130450n -> "1304.50" */
export function fromPaise(p: bigint): string {
  const negative = p < 0n;
  const abs = negative ? -p : p;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

export const sumPaise = (values: (string | null | undefined)[]) =>
  values.reduce((s, v) => s + toPaise(v), 0n);

/**
 * Applies `amount` to open bills, oldest first, until it runs out.
 * Returns the amount per bill id (bills that get nothing are left out).
 */
export function allocateOldestFirst(
  amount: string,
  bills: { id: string; balanceDue: string }[],
): Record<string, string> {
  let left = toPaise(amount);
  const result: Record<string, string> = {};
  for (const bill of bills) {
    if (left <= 0n) break;
    const due = toPaise(bill.balanceDue);
    const take = due < left ? due : left;
    if (take > 0n) {
      result[bill.id] = fromPaise(take);
      left -= take;
    }
  }
  return result;
}

/** Exact sum of decimal strings with `scale` decimals ("24.000" + "5.382" = "29.382"). */
export function sumDecimal(values: string[], scale: number): string {
  const factor = 10n ** BigInt(scale);
  let total = 0n;
  for (const v of values) {
    const [whole = '0', fraction = ''] = v.trim().replace('-', '').split('.');
    const units =
      BigInt(whole || '0') * factor + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
    total += v.trim().startsWith('-') ? -units : units;
  }
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const frac = scale ? `.${(abs % factor).toString().padStart(scale, '0')}` : '';
  return `${negative ? '-' : ''}${abs / factor}${frac}`;
}
