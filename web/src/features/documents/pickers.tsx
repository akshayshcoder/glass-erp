import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type KeyboardEvent, type Ref, useEffect, useId, useState } from 'react';
import { api } from '../../api/client';
import type { Page, Party, Product } from '../../api/types';
import { formatMoney, formatProductSpec } from '../../lib/format';
import { partyLabel } from '../../lib/party-type';
import { useDebounced } from '../../lib/use-debounced';

/*
 * Search-as-you-type pickers for the billing counter. Keyboard first:
 * type, Up/Down to move, Enter to pick (Enter with no selection picks the
 * first match), Esc to clear.
 */

interface ComboboxProps<T> {
  placeholder: string;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  search: (text: string) => Promise<T[]>;
  queryKey: string;
  getKey: (item: T) => string;
  render: (item: T) => React.ReactNode;
  onPick: (item: T) => void;
  minChars?: number;
}

function Combobox<T>({
  placeholder,
  autoFocus,
  inputRef,
  search,
  queryKey,
  getKey,
  render,
  onPick,
  minChars = 1,
}: ComboboxProps<T>) {
  const listId = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  /** Enter pressed before results arrived (fast typing, barcode scanners). */
  const [pendingEnter, setPendingEnter] = useState(false);
  const q = useDebounced(text.trim(), 150);

  const { data = [], isFetching } = useQuery({
    queryKey: [queryKey, q],
    queryFn: () => search(q),
    enabled: q.length >= minChars,
    staleTime: 30_000,
  });
  // Results are only valid for what is typed right now.
  const current = q === text.trim() && !isFetching;
  const items = q.length >= minChars ? data : [];

  function pick(item: T | undefined) {
    if (!item) return;
    onPick(item);
    setText('');
    setOpen(false);
    setActive(0);
    setPendingEnter(false);
  }

  useEffect(() => {
    if (pendingEnter && current) {
      if (items.length) pick(items[0]);
      else setPendingEnter(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnter, current, items]);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (current && items.length) pick(items[active] ?? items[0]);
      else if (text.trim().length >= minChars) setPendingEnter(true);
    } else if (e.key === 'Escape') {
      setText('');
      setOpen(false);
    }
  }

  const showList = open && q.length >= minChars;
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400"
        aria-hidden
      />
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className="block w-full rounded-md border-0 py-2 pr-3 pl-9 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md bg-white py-1 text-sm shadow-lg ring-1 ring-slate-200"
        >
          {items.length === 0 ? (
            <li className="px-3 py-2 text-slate-500">{isFetching ? 'Searching…' : 'No matches'}</li>
          ) : (
            items.map((item, i) => (
              <li
                key={getKey(item)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer px-3 py-2 ${i === active ? 'bg-brand-50' : ''}`}
              >
                {render(item)}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

export function ProductPicker(props: {
  onPick: (p: Product) => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <Combobox<Product>
      {...props}
      placeholder="Add product: type name, SKU, length (e.g. 7) or thickness (e.g. 8)…"
      queryKey="product-search"
      search={(q) =>
        api<Page<Product>>(`/v1/products?pageSize=8&search=${encodeURIComponent(q)}`).then(
          (r) => r.items,
        )
      }
      getKey={(p) => p.id}
      render={(p) => {
        const spec = formatProductSpec(p);
        return (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-slate-900">
                {p.name}
                {spec && (
                  <span className="ml-2 inline-flex items-center rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/20 ring-inset">
                    {spec}
                  </span>
                )}
              </p>
              <p className="text-xs text-slate-500">
                {p.sku} ·{' '}
                {p.measure === 'area'
                  ? 'by size'
                  : p.measure === 'length'
                    ? 'by length'
                    : p.unitCode}
              </p>
            </div>
            <p className="num text-xs text-slate-500">
              ₹{formatMoney(p.retailPrice)} / {p.unitCode}
            </p>
          </div>
        );
      }}
    />
  );
}

export function CustomerPicker(props: { onPick: (p: Party) => void; autoFocus?: boolean }) {
  return (
    <Combobox<Party>
      {...props}
      placeholder="Search customer by name, phone or GSTIN…"
      queryKey="customer-search"
      search={(q) =>
        api<Page<Party>>(
          `/v1/parties?kind=customer&pageSize=8&search=${encodeURIComponent(q)}`,
        ).then((r) => r.items)
      }
      getKey={(p) => p.id}
      render={(p) => {
        const hasWallet = p.walletBalance && Number(p.walletBalance) > 0;
        return (
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-medium text-slate-900">
                {partyLabel(p)}
              </p>
              <p className="text-xs text-slate-500">
                {[p.gstin, p.phone].filter(Boolean).join(' · ')}
              </p>
            </div>
            {hasWallet && (
              <span className="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-600/20">
                Wallet: ₹{p.walletBalance}
              </span>
            )}
          </div>
        );
      }}
    />
  );
}

export function SupplierPicker(props: { onPick: (p: Party) => void; autoFocus?: boolean }) {
  return (
    <Combobox<Party>
      {...props}
      placeholder="Search supplier by name, phone or GSTIN…"
      queryKey="supplier-search"
      search={(q) =>
        api<Page<Party>>(
          `/v1/parties?kind=supplier&pageSize=8&search=${encodeURIComponent(q)}`,
        ).then((r) => r.items)
      }
      getKey={(p) => p.id}
      render={(p) => (
        <div>
          <p className="font-medium text-slate-900">{p.name}</p>
          <p className="text-xs text-slate-500">
            {[p.gstin ?? 'Unregistered', p.phone].filter(Boolean).join(' · ')}
          </p>
        </div>
      )}
    />
  );
}
