/*
 * Display formatting. Values arrive as decimal strings from the API; these
 * functions only format them (no arithmetic), so nothing is rounded wrongly.
 */

/** "125430.5" -> "1,25,430.50" (Indian grouping). */
export function formatMoney(value: string | null | undefined, places = 2): string {
  if (value === null || value === undefined || value === '') return '';
  const negative = value.trim().startsWith('-');
  const [rawWhole = '0', rawFraction = ''] = value.replace('-', '').split('.');
  const fraction = (rawFraction + '0'.repeat(places)).slice(0, places);
  const last3 = rawWhole.slice(-3);
  const rest = rawWhole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${rest ? `${rest},` : ''}${last3}${places ? `.${fraction}` : ''}`;
}

/** "₹1,25,430.50" */
export const rupees = (value: string | null | undefined) => `₹${formatMoney(value)}`;

/** "24.500" -> "24.5", "24.000" -> "24" */
export function formatQty(value: string | null | undefined): string {
  if (!value) return '';
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** "2026-10-19" -> "19 Oct 2026" */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Today in India as YYYY-MM-DD. */
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

export const isNegative = (value: string | null | undefined) =>
  !!value && value.trim().startsWith('-');
export const isZero = (value: string | null | undefined) => !value || /^-?0*(\.0*)?$/.test(value);

/**
 * Formats a product's size/thickness specification (e.g. "7 inch × 8 mm · 20 pcs/box")
 * for hardware (T-bracket, hinges, bolts), glass and aluminium items.
 */
export function formatProductSpec(product: {
  thicknessMm?: string | null;
  attributes?: {
    length?: unknown;
    lengthUnit?: unknown;
    pcsPerBox?: unknown;
    finish?: unknown;
  };
}): string {
  const dims: string[] = [];
  const rawLen = typeof product.attributes?.length === 'string' ? product.attributes.length.trim() : '';
  const lenUnit =
    typeof product.attributes?.lengthUnit === 'string' && product.attributes.lengthUnit.trim()
      ? product.attributes.lengthUnit.trim()
      : 'inch';
  if (rawLen) dims.push(`${rawLen} ${lenUnit}`);
  if (product.thicknessMm && Number(product.thicknessMm) > 0) {
    dims.push(`${formatQty(product.thicknessMm)} mm`);
  }

  const extras: string[] = [];
  if (dims.length > 0) extras.push(dims.join(' × '));
  const finish =
    typeof product.attributes?.finish === 'string' ? product.attributes.finish.trim() : '';
  if (finish) extras.push(finish);
  const pcsPerBox = Number(product.attributes?.pcsPerBox);
  if (Number.isFinite(pcsPerBox) && pcsPerBox > 0) {
    extras.push(`1 Box = ${pcsPerBox} Pcs`);
  }
  return extras.join(' · ');
}
