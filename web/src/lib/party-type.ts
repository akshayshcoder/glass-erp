import type { CustomerType } from '../api/types';

export const CUSTOMER_TYPES: { value: CustomerType; label: string }[] = [
  { value: 'b2b', label: 'B2B' },
  { value: 'b2c', label: 'B2C' },
  { value: 'franchise', label: 'Franchise' },
  { value: 'walk_in', label: 'Walk-in' },
];

const LABELS = Object.fromEntries(CUSTOMER_TYPES.map((t) => [t.value, t.label]));

/** "B2B", "Walk-in" ... shown in brackets next to the party name. */
export function customerTypeLabel(type: CustomerType | null | undefined, gstin?: string | null) {
  if (type) return LABELS[type];
  return gstin ? 'B2B' : 'B2C';
}

/** Customer on a document (invoice, receipt...): no party behind it means a walk-in. */
export function docCustomerLabel(name: string | null | undefined, type: CustomerType | null | undefined) {
  return `${name || 'Cash Sale'} (${customerTypeLabel(type ?? 'walk_in')})`;
}

/** "Sharma Glass (B2B)" - the name always stays, the type goes in brackets. */
export function partyLabel(p: {
  name: string;
  kind?: string;
  customerType?: CustomerType | null;
  gstin?: string | null;
}) {
  if (p.kind === 'supplier') return p.name;
  return `${p.name} (${customerTypeLabel(p.customerType, p.gstin)})`;
}
