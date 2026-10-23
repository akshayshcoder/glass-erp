import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { type KeyboardEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import type { InvoiceLine, Product } from '../../api/types';
import { Select } from '../../components/ui';
import { formatMoney, formatProductSpec, formatQty, rupees } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { ProductPicker } from './pickers';

/*
 * The line editor used by every priced document: sales invoice, quotation,
 * purchase bill. Glass is entered as width x height x pieces, aluminium as
 * length x pieces, everything else as a quantity. The server prices the lines
 * (see useDocumentPreview); this file only collects input.
 */

export type SizeUnit = 'inch' | 'mm' | 'cm' | 'ft' | 'm';

/** What the editor needs to know about a product. */
export type LineProduct = Pick<
  Product,
  'id' | 'name' | 'hsnCode' | 'gstRate' | 'unitCode' | 'measure'
> &
  Partial<Pick<Product, 'thicknessMm' | 'attributes'>>;

export interface Row {
  key: string;
  product: LineProduct;
  qty: string;
  width: string;
  height: string;
  length: string;
  pieces: string;
  sizeUnit: SizeUnit;
  rate: string;
  discount: string;
  /**
   * Glass / aluminium can be entered by size (counter sales) or directly as a
   * quantity in their unit (e.g. 200 sq ft of sheets received from a supplier).
   */
  bySize: boolean;
}

/** Products that can be entered by size. */
const sizeable = (p: LineProduct) => p.measure === 'area' || p.measure === 'length';

const positive = (v: string) => /^\d*\.?\d+$/.test(v.trim()) && Number(v) > 0;
const nonNegative = (v: string) =>
  v.trim() === '' || (/^\d*\.?\d+$/.test(v.trim()) && Number(v) >= 0);
/** "36.000" -> "36" for editing. */
const plain = (v: string | null | undefined) => (v ? formatQty(v) : '');

export function newRow(product: LineProduct, preferQty = false): Row {
  return {
    key: crypto.randomUUID(),
    product,
    qty: '',
    width: '',
    height: '',
    length: '',
    pieces: '1',
    sizeUnit: product.measure === 'length' ? 'ft' : 'inch',
    rate: '',
    discount: '',
    bySize: sizeable(product) && !preferQty,
  };
}

/** A saved line back into an editable row (editing a draft). */
export function rowFromLine(line: InvoiceLine): Row {
  const measure = line.width ? 'area' : line.length ? 'length' : 'quantity';
  return {
    key: crypto.randomUUID(),
    product: {
      id: line.productId,
      name: line.description.replace(/ \(.*\)$/, ''),
      hsnCode: line.hsnCode,
      gstRate: line.gstRate,
      unitCode: line.unitCode,
      measure,
    },
    qty: measure === 'quantity' ? plain(line.qty) : '',
    width: plain(line.width),
    height: plain(line.height),
    length: plain(line.length),
    pieces: String(line.pieces ?? 1),
    sizeUnit: (line.sizeUnit as SizeUnit | null) ?? 'inch',
    rate: plain(line.rate),
    discount: line.discountAmount && Number(line.discountAmount) ? plain(line.discountAmount) : '',
    bySize: measure !== 'quantity',
  };
}

export type ApiLine = NonNullable<ReturnType<typeof toApiLine>>;

/** The row as an API line, or null while it is still incomplete. */
export function toApiLine(row: Row) {
  const { product } = row;
  if (!nonNegative(row.rate) || !nonNegative(row.discount)) return null;
  const base = {
    productId: product.id,
    ...(row.rate.trim() && { rate: row.rate.trim() }),
    ...(row.discount.trim() && { discount: row.discount.trim() }),
  };
  if (!row.bySize) return positive(row.qty) ? { ...base, qty: row.qty } : null;
  if (product.measure === 'area') {
    if (!positive(row.width) || !positive(row.height) || !positive(row.pieces)) return null;
    const size = {
      unit: row.sizeUnit,
      width: row.width,
      height: row.height,
      pieces: Number(row.pieces),
    };
    return { ...base, size };
  }
  if (product.measure === 'length') {
    if (!positive(row.length) || !positive(row.pieces)) return null;
    return {
      ...base,
      size: { unit: row.sizeUnit, length: row.length, pieces: Number(row.pieces) },
    };
  }
  return positive(row.qty) ? { ...base, qty: row.qty } : null;
}

/**
 * State + actions for a list of lines.
 * `preferQty`: new glass/aluminium lines start in quantity mode (purchases).
 */
export function useLineItems(initial: Row[] = [], { preferQty = false } = {}) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusKey) return;
    document.querySelector<HTMLInputElement>(`[data-row="${focusKey}"] input`)?.focus();
    setFocusKey(null);
  }, [focusKey]);

  const apiLines = rows.map(toApiLine);
  const complete = apiLines.filter((l): l is ApiLine => l !== null);

  return {
    rows,
    setRows,
    searchRef,
    /** Lines ready to send, in order (incomplete rows are skipped). */
    complete,
    allComplete: rows.length > 0 && complete.length === rows.length,
    add(product: LineProduct) {
      const row = newRow(product, preferQty);
      setRows((r) => [...r, row]);
      setFocusKey(row.key);
    },
    update(key: string, patch: Partial<Row>) {
      setRows((r) => r.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    },
    remove(key: string) {
      setRows((r) => r.filter((row) => row.key !== key));
    },
    /** The server-priced line for each complete row, matched by position. */
    pricedBy(previewLines: InvoiceLine[] | undefined): Map<string, InvoiceLine> {
      const map = new Map<string, InvoiceLine>();
      if (!previewLines) return map;
      let i = 0;
      rows.forEach((row, idx) => {
        if (apiLines[idx]) {
          const line = previewLines[i++];
          if (line) map.set(row.key, line);
        }
      });
      return map;
    },
  };
}

export type LineItemsState = ReturnType<typeof useLineItems>;

/**
 * Asks the server to price the document as the user types (debounced).
 * `body` must be JSON-serialisable; the query re-runs when it changes.
 */
export function useDocumentPreview<T>(path: string, body: object, enabled: boolean) {
  const payload = useDebounced(JSON.stringify(body), 300);
  return useQuery({
    queryKey: ['preview', path, payload],
    queryFn: () => api<T>(path, { method: 'POST', body: JSON.parse(payload) }),
    enabled,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function LineItems({
  items,
  priced,
  showDiscount = true,
}: {
  items: LineItemsState;
  priced: Map<string, InvoiceLine>;
  showDiscount?: boolean;
}) {
  /** Enter in the last field of a row jumps back to the product search. */
  const toSearch = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      items.searchRef.current?.focus();
    }
  };

  return (
    <>
      <div className="divide-y divide-slate-100">
        {items.rows.map((row, idx) => (
          <LineRow
            key={row.key}
            index={idx}
            row={row}
            priced={priced.get(row.key)}
            showDiscount={showDiscount}
            onChange={(patch) => items.update(row.key, patch)}
            onRemove={() => items.remove(row.key)}
            onLastEnter={toSearch}
          />
        ))}
      </div>
      <div className="border-t border-slate-200 p-4">
        <ProductPicker
          onPick={items.add}
          inputRef={items.searchRef as RefObject<HTMLInputElement>}
        />
      </div>
    </>
  );
}

function LineRow({
  index,
  row,
  priced,
  showDiscount,
  onChange,
  onRemove,
  onLastEnter,
}: {
  index: number;
  row: Row;
  priced: InvoiceLine | undefined;
  showDiscount: boolean;
  onChange: (patch: Partial<Row>) => void;
  onRemove: () => void;
  onLastEnter: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  const { product } = row;
  const { bySize } = row;
  const spec = formatProductSpec(product);
  const pcsPerBox = Number(product.attributes?.pcsPerBox || 0);
  const showBoxInput = !bySize && product.unitCode === 'PCS' && pcsPerBox > 0;
  const computedBoxes =
    showBoxInput && row.qty.trim() !== '' && Number(row.qty) > 0
      ? String(Number((Number(row.qty) / pcsPerBox).toFixed(2)))
      : '';

  return (
    <div data-row={row.key} className="grid gap-3 p-4 sm:grid-cols-[1.5rem_1fr_auto]">
      <span className="pt-2 text-sm text-slate-400">{index + 1}</span>
      <div className="space-y-2">
        <p className="font-medium text-slate-900">
          {product.name}
          {spec && (
            <span className="ml-2 inline-flex items-center rounded bg-brand-50 px-1.5 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/20 ring-inset">
              {spec}
            </span>
          )}
          <span className="ml-2 text-xs font-normal text-slate-500">
            HSN {product.hsnCode} · GST {Number(product.gstRate)}%
          </span>
          {sizeable(product) && (
            <button
              type="button"
              onClick={() => onChange({ bySize: !bySize })}
              className="ml-2 text-xs font-normal text-brand-700 hover:underline"
            >
              {bySize ? `enter ${product.unitCode} directly` : 'enter size'}
            </button>
          )}
        </p>
        <div className="flex flex-wrap items-end gap-2">
          {bySize && product.measure === 'area' && (
            <>
              <NumberBox label="Width" value={row.width} onChange={(v) => onChange({ width: v })} />
              <span className="pb-2 text-slate-400">×</span>
              <NumberBox
                label="Height"
                value={row.height}
                onChange={(v) => onChange({ height: v })}
              />
            </>
          )}
          {bySize && product.measure === 'length' && (
            <NumberBox
              label="Length"
              value={row.length}
              onChange={(v) => onChange({ length: v })}
            />
          )}
          {bySize && (
            <>
              <Select
                aria-label="Size unit"
                value={row.sizeUnit}
                onChange={(e) => onChange({ sizeUnit: e.target.value as SizeUnit })}
                className="w-20"
              >
                <option value="inch">in</option>
                <option value="mm">mm</option>
                <option value="cm">cm</option>
                <option value="ft">ft</option>
                <option value="m">m</option>
              </Select>
              <NumberBox
                label="Pcs"
                value={row.pieces}
                onChange={(v) => onChange({ pieces: v.replace(/\D/g, '') })}
                narrow
              />
            </>
          )}
          {!bySize && (
            <>
              <NumberBox
                label={`Qty (${product.unitCode})`}
                value={row.qty}
                onChange={(v) => onChange({ qty: v })}
              />
              {showBoxInput && (
                <NumberBox
                  label={`Boxes (×${pcsPerBox})`}
                  value={computedBoxes}
                  placeholder="Boxes"
                  onChange={(v) => {
                    const num = Number(v);
                    if (v.trim() === '') onChange({ qty: '' });
                    else if (!Number.isNaN(num)) onChange({ qty: String(num * pcsPerBox) });
                  }}
                />
              )}
            </>
          )}
          <NumberBox
            label={`Rate / ${product.unitCode}`}
            value={row.rate}
            placeholder={priced ? formatMoney(priced.rate) : 'auto'}
            onChange={(v) => onChange({ rate: v })}
            onKeyDown={showDiscount ? undefined : onLastEnter}
          />
          {showDiscount && (
            <NumberBox
              label="Discount ₹"
              value={row.discount}
              placeholder="0"
              onChange={(v) => onChange({ discount: v })}
              onKeyDown={onLastEnter}
            />
          )}
        </div>
        {bySize && priced && (
          <p className="text-xs text-slate-500">
            = {formatQty(priced.qty)} {product.unitCode}
          </p>
        )}
      </div>
      <div className="flex items-start gap-2 sm:flex-col sm:items-end">
        <p className="num pt-1 font-semibold text-slate-900">
          {priced ? rupees(priced.lineTotal) : '—'}
        </p>
        <button
          onClick={onRemove}
          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
          aria-label={`Remove ${product.name}`}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}

export function NumberBox({
  label,
  value,
  onChange,
  placeholder,
  narrow,
  onKeyDown,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  narrow?: boolean;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-xs text-slate-500">{label}</span>
      <input
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        onKeyDown={onKeyDown}
        className={`num block rounded-md border-0 px-2 py-2 text-right text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600 ${narrow ? 'w-14' : 'w-20'}`}
      />
    </label>
  );
}

/** The server-priced line for each row, from a preview result (cheap: no memo needed). */
export function usePricedLines(items: LineItemsState, lines: InvoiceLine[] | undefined) {
  return items.pricedBy(items.complete.length ? lines : undefined);
}
