import { describe, expect, it } from 'vitest';
import { amountInWords } from '../src/modules/documents/amount-in-words.js';
import { formatInr, formatRate } from '../src/modules/sales-invoices/invoice-pdf.js';
import {
  describeSize,
  documentTotals,
  lineAmounts,
  quantityFromSize,
  taxOn,
} from '../src/modules/documents/gst.js';

// Pure maths: no database needed.

describe('sizes -> billed quantity', () => {
  it('glass 36 x 48 inch x 2 pcs = 24 sq ft', () => {
    expect(
      quantityFromSize('area', 'SQFT', { unit: 'inch', width: '36', height: '48', pieces: 2 }),
    ).toBe('24.000');
  });
  it('glass in mm, billed in sq ft', () => {
    // 914.4 mm = 3 ft, 1219.2 mm = 4 ft
    expect(
      quantityFromSize('area', 'SQFT', { unit: 'mm', width: '914.4', height: '1219.2', pieces: 1 }),
    ).toBe('12.000');
  });
  it('glass billed in sq metres', () => {
    expect(
      quantityFromSize('area', 'SQM', { unit: 'cm', width: '100', height: '250', pieces: 3 }),
    ).toBe('7.500');
  });
  it('aluminium section: 16 ft x 5 bars = 80 running ft; 3 m = 9.843 ft', () => {
    expect(quantityFromSize('length', 'RFT', { unit: 'ft', length: '16', pieces: 5 })).toBe(
      '80.000',
    );
    expect(quantityFromSize('length', 'RFT', { unit: 'm', length: '3', pieces: 1 })).toBe('9.843');
  });
  it('rejects a size for a product not sold by size, or a wrong unit', () => {
    expect(() =>
      quantityFromSize('quantity', 'PCS', { unit: 'inch', width: '1', height: '1', pieces: 1 }),
    ).toThrow();
    expect(() =>
      quantityFromSize('area', 'PCS', { unit: 'inch', width: '1', height: '1', pieces: 1 }),
    ).toThrow();
    expect(() =>
      quantityFromSize('area', 'SQFT', { unit: 'inch', width: '1', pieces: 1 }),
    ).toThrow();
  });
  it('describes the size for the invoice', () => {
    expect(describeSize({ unit: 'inch', width: '36', height: '48', pieces: 2 })).toBe(
      '36 x 48 in x 2 pcs',
    );
    expect(describeSize({ unit: 'ft', length: '16', pieces: 1 })).toBe('16 ft x 1 pc');
    expect(describeSize({ unit: 'inch', width: '36.500', height: '48.000', pieces: 1 })).toBe(
      '36.5 x 48 in x 1 pc',
    );
  });
});

describe('GST per line', () => {
  it('same state: CGST = SGST = half', () => {
    expect(lineAmounts('24', '75', '0', '18', false)).toEqual({
      taxableValue: '1800.00',
      cgstAmount: '162.00',
      sgstAmount: '162.00',
      igstAmount: '0.00',
    });
  });
  it('other state: IGST only', () => {
    expect(lineAmounts('3', '250', '0', '18', true)).toMatchObject({
      igstAmount: '135.00',
      cgstAmount: '0.00',
    });
  });
  it('discount reduces the taxable value', () => {
    expect(lineAmounts('10', '100', '50', '18', false).taxableValue).toBe('950.00');
  });
  it('rounding: halves are rounded to the paisa, half-up', () => {
    // 10.05 x 18% = 1.809 -> half = 0.9045 -> 0.90 ; IGST 1.81
    expect(taxOn('10.05', '18', false)).toMatchObject({ cgstAmount: '0.90', sgstAmount: '0.90' });
    expect(taxOn('10.05', '18', true).igstAmount).toBe('1.81');
  });
  it('a discount larger than the amount is rejected', () => {
    expect(() => lineAmounts('1', '10', '11', '18', false)).toThrow();
  });
  it('no float drift: 0.1 + 0.2 style amounts stay exact', () => {
    const a = lineAmounts('3', '0.1', '0', '0', false);
    expect(a.taxableValue).toBe('0.30');
  });
});

describe('document totals', () => {
  it('sums lines and rounds to the rupee', () => {
    const t = documentTotals([
      lineAmounts('1', '99.99', '0', '18', false),
      lineAmounts('1', '10', '0', '5', false),
    ]);
    // taxable 109.99, tax 18.00 + 0.50 -> 128.49 -> 128.00, round off -0.49
    expect(t).toEqual({
      taxableValue: '109.99',
      cgstAmount: '9.25',
      sgstAmount: '9.25',
      igstAmount: '0.00',
      roundOff: '-0.49',
      grandTotal: '128.00',
    });
  });
});

describe('Indian digit grouping', () => {
  it.each([
    ['0', '0.00'],
    ['999', '999.00'],
    ['1000', '1,000.00'],
    ['125430.5', '1,25,430.50'],
    ['23500000', '2,35,00,000.00'],
    ['-0.49', '-0.49'],
  ])('%s -> %s', (value, formatted) => {
    expect(formatInr(value)).toBe(formatted);
  });

  it('rates keep their precision', () => {
    expect(formatRate('450.1750')).toBe('450.175');
    expect(formatRate('75.0000')).toBe('75.00');
    expect(formatRate('1234.5')).toBe('1,234.50');
  });
});

describe('amount in words (Indian numbering)', () => {
  it.each([
    ['0', 'Rupees Zero Only'],
    ['3304', 'Rupees Three Thousand Three Hundred Four Only'],
    ['125430.50', 'Rupees One Lakh Twenty Five Thousand Four Hundred Thirty and Fifty Paise Only'],
    ['23500000', 'Rupees Two Crore Thirty Five Lakh Only'],
  ])('%s', (amount, words) => {
    expect(amountInWords(amount)).toBe(words);
  });
});
