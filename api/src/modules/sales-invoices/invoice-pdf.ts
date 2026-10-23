import { Decimal } from 'decimal.js';
import PDFDocument from 'pdfkit';
import { amountInWords } from '../documents/amount-in-words.js';

/*
 * A4 GST tax invoice. Contains what a GST invoice must show: supplier name,
 * address and GSTIN; invoice number and date; recipient name, address and GSTIN
 * (B2B); place of supply; HSN, quantity, unit, rate, taxable value, tax rate and
 * amounts per line; totals; amount in words; signature.
 *
 * Uses the built-in Helvetica font, which has no ₹ glyph, so amounts print as
 * "Rs." (embedding a font with ₹ is a later improvement).
 */

export interface InvoiceForPdf {
  status: string;
  invoiceNo: string | null;
  invoiceDate: string;
  dueDate: string | null;
  supplyType: string;
  customerName: string;
  customerGstin: string | null;
  customerPhone: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  placeOfSupply: string;
  sellerStateCode: string;
  reverseCharge: boolean;
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  roundOff: string;
  grandTotal: string;
  notes: string | null;
  lines: {
    lineNo: number;
    description: string;
    hsnCode: string;
    qty: string;
    unitCode: string;
    rate: string;
    discountAmount: string;
    taxableValue: string;
    gstRate: string;
    cgstAmount: string;
    sgstAmount: string;
    igstAmount: string;
    lineTotal: string;
  }[];
}

export interface SellerForPdf {
  tenant_name: string;
  legal_name: string | null;
  branch_name: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  gstin: string | null;
  state_code: string;
  state_name: string;
}

/** 125430.5 -> "1,25,430.50" (Indian digit grouping). */
export function formatInr(value: string, places = 2): string {
  const [whole, fraction] = new Decimal(value).toFixed(places).split('.') as [string, string];
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${rest ? `${rest},` : ''}${last3}.${fraction}`;
}

const trimQty = (q: string) => new Decimal(q).toString();

/** Rates keep their real precision (450.175 stays 450.175), with at least 2 decimals. */
export function formatRate(rate: string): string {
  return formatInr(rate, Math.max(2, new Decimal(rate).decimalPlaces()));
}

/**
 * The same layout prints quotations and credit notes; only the title, the
 * number label and a few detail rows differ. Defaults = tax invoice.
 */
export interface DocumentKind {
  title: string;
  numberLabel: string;
  /** Extra rows in the top-right block, e.g. ['Valid until', '2026-11-30']. */
  details?: [string, string][];
  /** Printed above the signature, e.g. quotation terms. */
  terms?: string | null;
  footer?: string;
}

function invoiceKind(status: string): DocumentKind {
  return {
    title:
      status === 'draft'
        ? 'DRAFT - NOT A TAX INVOICE'
        : status === 'cancelled'
          ? 'TAX INVOICE (CANCELLED)'
          : 'TAX INVOICE',
    numberLabel: 'Invoice No.',
    footer: 'This is a computer-generated invoice.',
  };
}

export function renderInvoicePdf(
  inv: InvoiceForPdf,
  seller: SellerForPdf,
  placeOfSupplyName: string,
  kind: DocumentKind = invoiceKind(inv.status),
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    info: { Title: `${kind.numberLabel} ${inv.invoiceNo ?? 'draft'}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    doc.on('end', () => resolve(Buffer.concat(chunks))),
  );

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const interState = inv.placeOfSupply !== inv.sellerStateCode;

  // ---- Title -----------------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(14).text(kind.title, left, 36, { width, align: 'center' });
  doc.moveDown(0.5);

  // ---- Seller (left) and invoice details (right) ------------------------------
  const top = doc.y;
  doc.fontSize(12).text(seller.legal_name ?? seller.tenant_name, left, top, { width: width * 0.6 });
  doc.font('Helvetica').fontSize(9);
  const sellerLines = [
    seller.branch_name,
    [seller.address, seller.city, seller.pincode].filter(Boolean).join(', '),
    seller.phone ? `Phone: ${seller.phone}` : '',
    seller.gstin ? `GSTIN: ${seller.gstin}` : 'Unregistered',
    `State: ${seller.state_name} (${seller.state_code})`,
  ].filter(Boolean);
  for (const line of sellerLines) doc.text(line, { width: width * 0.6 });
  const sellerBottom = doc.y;

  const details: [string, string][] = [
    [kind.numberLabel, inv.invoiceNo ?? '(draft)'],
    ['Date', inv.invoiceDate],
    ...(inv.dueDate ? ([['Due date', inv.dueDate]] as [string, string][]) : []),
    ...(kind.details ?? []),
    ['Place of supply', `${placeOfSupplyName} (${inv.placeOfSupply})`],
    ['Reverse charge', inv.reverseCharge ? 'Yes' : 'No'],
  ];
  let y = top;
  for (const [label, value] of details) {
    doc.font('Helvetica').text(label, left + width * 0.62, y, { width: width * 0.15 });
    doc.font('Helvetica-Bold').text(value, left + width * 0.77, y, { width: width * 0.23 });
    y += 13;
  }
  doc.y = Math.max(sellerBottom, y) + 8;
  doc
    .moveTo(left, doc.y)
    .lineTo(left + width, doc.y)
    .stroke();
  doc.moveDown(0.5);

  // ---- Buyer --------------------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(9).text('Bill to', left);
  doc.font('Helvetica-Bold').fontSize(10).text(inv.customerName);
  doc.font('Helvetica').fontSize(9);
  for (const line of [
    inv.billingAddress,
    inv.customerGstin ? `GSTIN: ${inv.customerGstin}` : '',
    inv.customerPhone ? `Phone: ${inv.customerPhone}` : '',
    inv.shippingAddress && inv.shippingAddress !== inv.billingAddress
      ? `Ship to: ${inv.shippingAddress}`
      : '',
  ]) {
    if (line) doc.text(line, { width });
  }
  doc.moveDown(0.8);

  // ---- Lines table --------------------------------------------------------------
  const cols = [
    { title: '#', w: 0.04, align: 'left' },
    { title: 'Description', w: 0.27, align: 'left' },
    { title: 'HSN', w: 0.07, align: 'left' },
    { title: 'Qty', w: 0.12, align: 'right' },
    { title: 'Rate', w: 0.1, align: 'right' },
    { title: 'Taxable', w: 0.12, align: 'right' },
    { title: 'GST %', w: 0.07, align: 'right' },
    { title: interState ? 'IGST' : 'Tax', w: 0.1, align: 'right' },
    { title: 'Amount', w: 0.11, align: 'right' },
  ] as const;

  const drawRow = (cells: string[], bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    const rowTop = doc.y;
    let x = left;
    let rowBottom = rowTop;
    cells.forEach((cell, i) => {
      const col = cols[i]!;
      const w = col.w * width;
      doc.text(cell, x + 2, rowTop, { width: w - 4, align: col.align });
      rowBottom = Math.max(rowBottom, doc.y);
      x += w;
    });
    doc.y = rowBottom + 3;
  };
  const drawHeader = () => {
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .stroke();
    doc.y += 3;
    drawRow(
      cols.map((c) => c.title),
      true,
    );
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .stroke();
    doc.y += 3;
  };

  drawHeader();
  for (const l of inv.lines) {
    if (doc.y > doc.page.height - 200) {
      doc.addPage();
      drawHeader();
    }
    const tax = new Decimal(l.cgstAmount).plus(l.sgstAmount).plus(l.igstAmount).toFixed(2);
    drawRow([
      String(l.lineNo),
      l.description,
      l.hsnCode,
      `${trimQty(l.qty)} ${l.unitCode}`,
      formatRate(l.rate),
      formatInr(l.taxableValue),
      `${new Decimal(l.gstRate).toString()}%`,
      formatInr(tax),
      formatInr(l.lineTotal),
    ]);
  }
  doc
    .moveTo(left, doc.y)
    .lineTo(left + width, doc.y)
    .stroke();
  doc.moveDown(0.5);

  // ---- Totals ---------------------------------------------------------------------
  const totals: [string, string][] = [
    ['Taxable value', inv.taxableValue],
    ...((interState
      ? [['IGST', inv.igstAmount]]
      : [
          ['CGST', inv.cgstAmount],
          ['SGST', inv.sgstAmount],
        ]) as [string, string][]),
    ['Round off', inv.roundOff],
  ];
  doc.font('Helvetica').fontSize(9);
  for (const [label, value] of totals) {
    const rowY = doc.y;
    doc.text(label, left + width * 0.6, rowY, { width: width * 0.2 });
    doc.text(formatInr(value), left + width * 0.8, rowY, { width: width * 0.2, align: 'right' });
  }
  const totalY = doc.y + 2;
  doc.font('Helvetica-Bold').fontSize(11);
  doc.text('Total (Rs.)', left + width * 0.6, totalY, { width: width * 0.2 });
  doc.text(formatInr(inv.grandTotal), left + width * 0.8, totalY, {
    width: width * 0.2,
    align: 'right',
  });
  doc.moveDown(0.8);

  doc
    .font('Helvetica')
    .fontSize(9)
    .text(`Amount in words: ${amountInWords(inv.grandTotal)}`, left, doc.y, { width });
  if (inv.notes) doc.moveDown(0.5).text(`Notes: ${inv.notes}`, { width });
  if (kind.terms) doc.moveDown(0.5).text(`Terms: ${kind.terms}`, { width });

  // ---- Signature ------------------------------------------------------------------
  doc.moveDown(3);
  const signY = doc.y;
  doc.fontSize(8).text(kind.footer ?? 'This is a computer-generated document.', left, signY, {
    width: width * 0.5,
  });
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .text(`For ${seller.legal_name ?? seller.tenant_name}`, left + width * 0.5, signY, {
      width: width * 0.5,
      align: 'right',
    });
  doc.moveDown(2.5);
  doc.font('Helvetica').text('Authorised Signatory', left + width * 0.5, doc.y, {
    width: width * 0.5,
    align: 'right',
  });

  doc.end();
  return done;
}
