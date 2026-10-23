import { z } from 'zod';
import { queryOne } from '../../db/sql.js';
import type { DbClient } from '../../db/transaction.js';
import { AppError } from '../../http/errors.js';
import { Phone, StateCode, Uuid } from '../../http/validation.js';

/*
 * Who a sales document is for, and where it is billed from. Shared by invoices
 * and quotations.
 *
 *   * With a customer (party): name, GSTIN, phone and addresses are copied from
 *     the customer master as a SNAPSHOT: later edits to the customer never
 *     change an issued document.
 *   * Without one: a walk-in (B2C) sale; a name/phone may be typed in.
 *   * B2B when the customer has a GSTIN, otherwise B2C.
 *   * Place of supply: given, else the customer's state, else the branch's.
 *     Same state as the branch -> CGST + SGST, otherwise IGST.
 */

export const CustomerFields = {
  branchId: Uuid,
  partyId: Uuid.nullable().optional(),
  customerName: z.string().trim().min(1).max(200).optional(),
  customerPhone: Phone.optional(),
  billingAddress: z.string().trim().max(500).optional(),
  shippingAddress: z.string().trim().max(500).optional(),
  placeOfSupply: StateCode.optional(),
};

export interface CustomerInput {
  branchId: string;
  partyId?: string | null;
  customerName?: string;
  customerPhone?: string;
  billingAddress?: string;
  shippingAddress?: string;
  placeOfSupply?: string;
}

export interface BranchRow {
  id: string;
  state_code: string;
  gstin: string | null;
  is_active: boolean;
}

export async function loadActiveBranch(c: DbClient, branchId: string): Promise<BranchRow> {
  const branch = await queryOne<BranchRow>(
    c,
    'SELECT id, state_code, gstin, is_active FROM erp.branches WHERE id = $1',
    [branchId],
  );
  if (!branch) throw new AppError(422, 'INVALID_REFERENCE', 'Branch not found');
  if (!branch.is_active) throw new AppError(422, 'BUSINESS_RULE', 'This branch is inactive');
  return branch;
}

export async function resolveCustomer(c: DbClient, input: CustomerInput) {
  const branch = await loadActiveBranch(c, input.branchId);
  const party = input.partyId
    ? await queryOne<{
        id: string;
        kind: string;
        name: string;
        gstin: string | null;
        state_code: string | null;
        phone: string | null;
        billing_address: string | null;
        shipping_address: string | null;
        is_active: boolean;
      }>(c, 'SELECT * FROM erp.parties WHERE id = $1', [input.partyId])
    : null;
  if (input.partyId && !party) throw new AppError(422, 'INVALID_REFERENCE', 'Customer not found');
  if (party && party.kind === 'supplier')
    throw new AppError(422, 'BUSINESS_RULE', `"${party.name}" is not a customer`);
  if (party && !party.is_active)
    throw new AppError(422, 'BUSINESS_RULE', `"${party.name}" is inactive`);

  const supplyType = party?.gstin ? 'b2b' : 'b2c';
  const placeOfSupply = input.placeOfSupply ?? party?.state_code ?? branch.state_code;
  return {
    branch,
    supplyType: supplyType as 'b2b' | 'b2c',
    interState: placeOfSupply !== branch.state_code,
    /** Snapshot columns, identical on invoices and quotations. */
    columns: {
      branch_id: branch.id,
      supply_type: supplyType,
      party_id: party?.id ?? null,
      customer_name: party?.name ?? input.customerName ?? 'Cash Sale',
      customer_gstin: party?.gstin ?? null,
      customer_phone: input.customerPhone ?? party?.phone ?? null,
      billing_address: input.billingAddress ?? party?.billing_address ?? null,
      shipping_address: input.shippingAddress ?? party?.shipping_address ?? null,
      place_of_supply: placeOfSupply,
      seller_state_code: branch.state_code,
    },
  };
}
