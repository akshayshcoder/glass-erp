import type { FastifyReply, FastifyRequest } from 'fastify';
import { queryOne } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import {
  type DocumentKind,
  type InvoiceForPdf,
  type SellerForPdf,
  renderInvoicePdf,
} from '../sales-invoices/invoice-pdf.js';

/*
 * Sends a sales-side document (invoice, quotation, credit note) as an inline
 * PDF, and records who printed it in the audit log.
 */

export interface PdfSource {
  /** The document shaped for the renderer (see InvoiceForPdf). */
  doc: InvoiceForPdf & { branchId: string };
  kind?: DocumentKind;
  audit: { event: string; entityType: string; entityId: string };
}

async function loadSeller(c: DbClient, branchId: string): Promise<SellerForPdf> {
  const seller = await queryOne<SellerForPdf>(
    c,
    `SELECT t.name AS tenant_name, t.legal_name, b.name AS branch_name, b.address, b.city, b.pincode,
            b.phone, b.gstin, b.state_code, s.name AS state_name
     FROM erp.branches b JOIN erp.tenants t ON t.id = b.tenant_id JOIN erp.states s ON s.code = b.state_code
     WHERE b.id = $1`,
    [branchId],
  );
  return seller!;
}

export async function sendDocumentPdf(
  request: FastifyRequest,
  reply: FastifyReply,
  build: (c: DbClient) => Promise<PdfSource>,
) {
  const { pdf, fileName } = await request.tx(async (c) => {
    const { doc, kind, audit } = await build(c);
    const seller = await loadSeller(c, doc.branchId);
    const pos = await queryOne<{ name: string }>(c, 'SELECT name FROM erp.states WHERE code = $1', [
      doc.placeOfSupply,
    ]);
    await c.query(`SELECT audit.log_event($1, $2, $3, '{}')`, [
      audit.event,
      audit.entityType,
      audit.entityId,
    ]);
    return {
      pdf: await renderInvoicePdf(doc, seller, pos?.name ?? doc.placeOfSupply, kind),
      fileName: (doc.invoiceNo ?? 'draft').replace(/[^A-Za-z0-9-]/g, '_'),
    };
  });
  return reply
    .type('application/pdf')
    .header('content-disposition', `inline; filename="${fileName}.pdf"`)
    .send(pdf);
}
