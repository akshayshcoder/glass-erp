/**
 * Who can do what, in one place.
 *
 * The database re-checks the same rules inside its business functions
 * (erp.require_role), so keep the two in sync when changing a list here.
 */
export const ROLES = [
  'owner',
  'admin',
  'manager',
  'billing',
  'storekeeper',
  'accountant',
  'viewer',
] as const;

export type Role = (typeof ROLES)[number];

export const Permissions = {
  /** Any member of the shop. */
  read: ROLES,
  manageShop: ['owner'],
  manageTeam: ['owner', 'admin'],
  viewTeam: ['owner', 'admin', 'manager'],
  manageProducts: ['owner', 'admin', 'manager', 'storekeeper'],
  manageParties: ['owner', 'admin', 'manager', 'billing'],
  postOpeningBalance: ['owner', 'admin'],
  adjustStock: ['owner', 'admin', 'manager', 'storekeeper'],

  // Documents. "cancel" is stricter than "create/post" everywhere.
  sell: ['owner', 'admin', 'manager', 'billing'], //                erp.post_sales_invoice, erp.post_receipt
  cancelSales: ['owner', 'admin', 'manager'], //                     erp.cancel_sales_invoice, erp.cancel_receipt
  purchase: ['owner', 'admin', 'manager', 'storekeeper'], //         erp.post_purchase_bill
  cancelPurchase: ['owner', 'admin', 'manager'], //                  erp.cancel_purchase_bill
  paySuppliers: ['owner', 'admin', 'manager'], //                    erp.post/cancel_supplier_payment
  creditNotes: ['owner', 'admin', 'manager'], //                     erp.post/cancel_credit_note
  quote: ['owner', 'admin', 'manager', 'billing'], //                erp.*_quotation
  lockGstPeriod: ['owner', 'admin', 'accountant'], //                erp.lock_gst_period
  reports: ['owner', 'admin', 'manager', 'accountant'],
  unlockGstPeriod: ['owner', 'admin'], //                            erp.unlock_gst_period
} as const satisfies Record<string, readonly Role[]>;
