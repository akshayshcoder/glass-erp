/*
 * Shapes returned by the API (see docs/02-api.md). Money, quantities and rates
 * are decimal STRINGS: display them, never do float maths on them.
 */

export type Role =
  'owner' | 'admin' | 'manager' | 'billing' | 'storekeeper' | 'accountant' | 'viewer';
export type DocStatus = 'draft' | 'posted' | 'cancelled';

export interface Page<T> {
  items: T[];
  nextPageToken: string | null;
}

export interface Me {
  user: { id: string; fullName: string; email: string | null; phone: string | null };
  memberships: { tenantId: string; tenantName: string; role: Role }[];
}

export interface Reference {
  units: { code: string; name: string; gstUqc: string; decimals: number }[];
  states: { code: string; name: string }[];
}

export interface Tenant {
  id: string;
  name: string;
  legalName: string | null;
  pan: string | null;
  plan: string;
  status: string;
  version: number;
}

export interface Branch {
  id: string;
  code: string;
  name: string;
  gstin: string | null;
  stateCode: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  allowNegativeStock?: boolean;
  isActive: boolean;
  version: number;
}

export type ProductKind = 'glass' | 'aluminium' | 'hardware' | 'service' | 'other';
export type Measure = 'quantity' | 'area' | 'length' | 'weight';

export interface ProductAttributes {
  length?: string;
  lengthUnit?: 'inch' | 'mm' | 'cm' | 'ft' | 'm';
  pcsPerBox?: number;
  finish?: string;
  [key: string]: unknown;
}

export interface Product {
  id: string;
  sku: string;
  name: string;
  kind: ProductKind;
  hsnCode: string;
  gstRate: string;
  unitCode: string;
  measure: Measure;
  thicknessMm: string | null;
  attributes?: ProductAttributes;
  retailPrice: string;
  wholesalePrice: string;
  purchasePrice: string;
  trackInventory: boolean;
  reorderLevel: string;
  isActive: boolean;
  version: number;
}

export type PartyKind = 'customer' | 'supplier' | 'both';
export type CustomerType = 'walk_in' | 'franchise' | 'b2b' | 'b2c';

export interface Party {
  id: string;
  kind: PartyKind;
  customerType?: CustomerType;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  pincode: string | null;
  creditLimit: string;
  creditDays: number;
  isActive: boolean;
  version: number;
  balance?: string;
  walletBalance?: string;
  totalOutstanding?: string;
  availableCredit?: string | null;
  unpaidInvoicesCount?: number;
}

export interface CustomerWalletReceipt {
  id: string;
  receiptNo: string | null;
  receiptDate: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  notes: string | null;
}

export interface CustomerUnpaidInvoice {
  id: string;
  invoiceNo: string | null;
  invoiceDate: string;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
}

export interface CustomerWallet {
  partyId: string;
  walletBalance: string;
  unallocatedReceiptsCount: number;
  totalOutstanding: string;
  availableCredit: string | null;
  receipts: CustomerWalletReceipt[];
  unpaidInvoices: CustomerUnpaidInvoice[];
}

export interface KnockoffResult {
  settledCount: number;
  totalSettled: string;
  remainingWallet: string;
}

export interface LedgerEntry {
  id: string;
  date: string;
  type: string;
  refId: string | null;
  refNo: string | null;
  debit: string;
  credit: string;
  narration: string | null;
  balance: string;
}

export interface Ledger {
  openingBalance: string;
  closingBalance: string;
  entries: LedgerEntry[];
}

export interface StockItem {
  branchId: string;
  productId: string;
  sku: string;
  name: string;
  kind: ProductKind;
  unitCode: string;
  thicknessMm?: string | null;
  attributes?: ProductAttributes;
  qty: string;
  reorderLevel: string;
  needsReorder: boolean;
}

export interface InvoiceLine {
  id?: string;
  lineNo: number;
  productId: string;
  description: string;
  hsnCode: string;
  unitCode: string;
  sizeUnit: string | null;
  width: string | null;
  height: string | null;
  length: string | null;
  pieces: number | null;
  qty: string;
  rate: string;
  discountAmount: string;
  taxableValue: string;
  gstRate: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  lineTotal?: string;
}

export interface InvoiceTotals {
  taxableValue: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  roundOff: string;
  grandTotal: string;
}

export interface InvoiceSummary {
  id: string;
  branchId: string;
  status: DocStatus;
  invoiceNo: string | null;
  invoiceDate: string;
  supplyType: 'b2b' | 'b2c';
  partyId: string | null;
  customerName: string;
  customerType?: CustomerType;
  customerGstin: string | null;
  grandTotal: string;
  amountPaid: string;
  amountCredited: string;
  balanceDue: string;
}

export interface Invoice extends InvoiceSummary, InvoiceTotals {
  dueDate: string | null;
  customerPhone: string | null;
  billingAddress: string | null;
  shippingAddress: string | null;
  placeOfSupply: string;
  sellerStateCode: string;
  sellerGstin: string | null;
  notes: string | null;
  cancelReason: string | null;
  postedAt: string | null;
  version: number;
  lines: InvoiceLine[];
}

export interface InvoicePreview extends InvoiceTotals {
  supplyType: 'b2b' | 'b2c';
  placeOfSupply: string;
  sellerStateCode: string;
  customerName: string;
  lines: InvoiceLine[];
}

export interface Dashboard {
  today: { sales: string; invoices: number };
  month: { sales: string; invoices: number };
  receivable: string;
  payable: string;
  lowStockItems: number;
  recentInvoices: {
    id: string;
    invoiceNo: string | null;
    invoiceDate: string;
    customerName: string;
    customerType?: CustomerType;
    grandTotal: string;
    status: DocStatus;
    balanceDue: string;
  }[];
}

export type PaymentMode = 'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque';

/** Totals + lines shared by every priced document (invoice, quotation, bill, credit note). */
export interface PricedDocument extends InvoiceTotals {
  lines: InvoiceLine[];
}

export type QuotationStatus =
  'draft' | 'issued' | 'accepted' | 'rejected' | 'converted' | 'cancelled';

export interface Quotation extends PricedDocument {
  id: string;
  branchId: string;
  status: QuotationStatus;
  quoteNo: string | null;
  quoteDate: string;
  validUntil: string | null;
  isExpired?: boolean;
  supplyType: 'b2b' | 'b2c';
  partyId: string | null;
  customerName: string;
  customerType?: CustomerType;
  customerGstin: string | null;
  customerPhone: string | null;
  placeOfSupply: string;
  sellerStateCode: string;
  notes: string | null;
  terms: string | null;
  invoiceId: string | null;
  cancelReason: string | null;
  version: number;
}

export interface PurchaseBill extends PricedDocument {
  id: string;
  branchId: string;
  status: DocStatus;
  docNo: string | null;
  entryDate: string;
  supplierId: string;
  supplierName: string;
  supplierGstin: string | null;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  supplierStateCode: string;
  buyerStateCode: string;
  reverseCharge: boolean;
  itcEligible: boolean;
  amountPaid: string;
  balanceDue: string;
  notes: string | null;
  cancelReason: string | null;
  version: number;
}

export interface PurchaseBillSummary {
  id: string;
  status: DocStatus;
  docNo: string | null;
  entryDate: string;
  supplierId: string;
  supplierName: string;
  supplierInvoiceNo: string;
  supplierInvoiceDate: string;
  grandTotal: string;
  amountPaid: string;
  balanceDue: string;
}

export interface CreditNote extends PricedDocument {
  id: string;
  branchId: string;
  status: DocStatus;
  noteNo: string | null;
  noteDate: string;
  invoiceId: string;
  invoiceNo: string | null;
  partyId: string | null;
  reason: 'sales_return' | 'rate_difference' | 'discount' | 'deficiency' | 'other';
  restock: boolean;
  customerName: string;
  customerType?: CustomerType;
  customerGstin: string | null;
  placeOfSupply: string;
  sellerStateCode: string;
  remarks: string | null;
  cancelReason: string | null;
}

export interface Receipt {
  id: string;
  branchId: string;
  status: DocStatus;
  receiptNo: string | null;
  receiptDate: string;
  partyId: string | null;
  partyName?: string | null;
  customerType?: CustomerType;
  mode: PaymentMode;
  amount: string;
  referenceNo: string | null;
  notes: string | null;
  cancelReason: string | null;
  allocations?: { invoiceId: string; invoiceNo: string | null; amount: string }[];
  advanceAllocations?: { invoiceId: string; invoiceNo: string | null; amount: string }[];
  unallocatedAmount?: string;
}

export interface SupplierPayment {
  id: string;
  branchId: string;
  status: DocStatus;
  paymentNo: string | null;
  paymentDate: string;
  supplierId: string;
  supplierName?: string;
  mode: PaymentMode;
  amount: string;
  referenceNo: string | null;
  cancelReason: string | null;
  allocations?: {
    billId: string;
    docNo: string | null;
    supplierInvoiceNo: string;
    amount: string;
  }[];
}

export interface Member {
  id: string;
  userId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  role: Role;
  branchIds: string[] | null;
  status: 'active' | 'disabled';
  version: number;
}

export interface GstLock {
  branchId: string;
  period: string;
  note: string | null;
  lockedAt: string;
  lockedByName: string | null;
}
