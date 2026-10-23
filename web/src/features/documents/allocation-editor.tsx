import { Button } from '../../components/ui';
import { formatDate, rupees } from '../../lib/format';
import { allocateOldestFirst, fromPaise, sumPaise, toPaise } from '../../lib/money';

/*
 * Splits a payment across open bills (customer invoices or supplier bills).
 * Whatever is not applied stays as an advance on the party's account.
 */

export interface OpenBill {
  id: string;
  number: string | null;
  date: string;
  total: string;
  balanceDue: string;
}

export function AllocationEditor({
  amount,
  bills,
  value,
  onChange,
}: {
  amount: string;
  bills: OpenBill[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const applied = sumPaise(Object.values(value));
  const left = toPaise(amount) - applied;

  if (bills.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No unpaid bills. The amount will be kept as an advance.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-medium text-slate-700">Apply to bills</p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange(allocateOldestFirst(amount, bills))}
        >
          Apply to oldest first
        </Button>
      </div>
      <div className="divide-y divide-slate-100 rounded-md ring-1 ring-slate-200">
        {bills.map((b) => (
          <label key={b.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <span className="flex-1">
              <span className="font-medium text-slate-900">{b.number}</span>
              <span className="ml-2 text-xs text-slate-500">
                {formatDate(b.date)} · due {rupees(b.balanceDue)}
              </span>
            </span>
            <input
              inputMode="decimal"
              aria-label={`Amount for ${b.number}`}
              placeholder="0.00"
              value={value[b.id] ?? ''}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, '');
                const next = { ...value };
                if (v) next[b.id] = v;
                else delete next[b.id];
                onChange(next);
              }}
              className="num w-28 rounded-md border-0 px-2 py-1.5 text-right ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
            />
          </label>
        ))}
      </div>
      <p className={`mt-2 text-xs ${left < 0n ? 'text-red-600' : 'text-slate-500'}`}>
        Applied {rupees(fromPaise(applied))}
        {left > 0n && ` · ${rupees(fromPaise(left))} kept as advance`}
        {left < 0n && ' · more than the amount received'}
      </p>
    </div>
  );
}

/** Allocations as API rows, skipping empty/zero entries. */
export function allocationRows<K extends string>(value: Record<string, string>, key: K) {
  return Object.entries(value)
    .filter(([, amount]) => toPaise(amount) > 0n)
    .map(
      ([id, amount]) =>
        ({ [key]: id, amount: fromPaise(toPaise(amount)) }) as Record<K, string> & {
          amount: string;
        },
    );
}
