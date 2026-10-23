import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, api, errorMessage } from '../../api/client';
import type { Page, Product, ProductKind } from '../../api/types';
import { useCan } from '../../app/auth';
import { useReference } from '../../app/shop-data';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  useToast,
} from '../../components/ui';
import { useDebounced } from '../../lib/use-debounced';
import { formatMoney, formatProductSpec } from '../../lib/format';

const KINDS: { value: ProductKind; label: string }[] = [
  { value: 'glass', label: 'Glass' },
  { value: 'aluminium', label: 'Aluminium' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'service', label: 'Service' },
  { value: 'other', label: 'Other' },
];
/** Sensible starting values per kind (usual HSN chapter, unit and how it is sold). */
const KIND_DEFAULTS: Record<
  ProductKind,
  { unitCode: string; measure: string; hsnCode: string; trackInventory: boolean }
> = {
  glass: { unitCode: 'SQFT', measure: 'area', hsnCode: '7005', trackInventory: true },
  aluminium: { unitCode: 'RFT', measure: 'length', hsnCode: '7604', trackInventory: true },
  hardware: { unitCode: 'PCS', measure: 'quantity', hsnCode: '8302', trackInventory: true },
  service: { unitCode: 'NOS', measure: 'quantity', hsnCode: '9954', trackInventory: false },
  other: { unitCode: 'PCS', measure: 'quantity', hsnCode: '', trackInventory: true },
};

const MEASURES = [
  { value: 'quantity', label: 'By quantity (pcs, box, set…)' },
  { value: 'area', label: 'By area: width × height (glass)' },
  { value: 'length', label: 'By length (aluminium section / running length)' },
  { value: 'weight', label: 'By weight (kg)' },
];

const LENGTH_UNITS = [
  { value: 'inch', label: 'inch (in)' },
  { value: 'mm', label: 'mm' },
  { value: 'cm', label: 'cm' },
  { value: 'ft', label: 'feet (ft)' },
  { value: 'm', label: 'meter (m)' },
] as const;

export function ProductsPage() {
  const canEdit = useCan('manageProducts');
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('active');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const q = useDebounced(search.trim(), 250);

  const params = new URLSearchParams({
    pageSize: '100',
    status,
    ...(q && { search: q }),
    ...(kind && { kind }),
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['products', params.toString()],
    queryFn: () => api<Page<Product>>(`/v1/products?${params}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Products"
        subtitle="Glass, aluminium sections and hardware (with length, thickness & box/pcs specs)"
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              New product
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-60 flex-1">
            <Search
              className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400"
              aria-hidden
            />
            <input
              type="search"
              placeholder="Search name, SKU, size (e.g. 7 inch) or thickness (e.g. 8mm)…"
              aria-label="Search products"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="block w-full rounded-md border-0 py-2 pr-3 pl-9 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
            />
          </div>
          <Select
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-40"
          >
            <option value="">All kinds</option>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-36"
          >
            <option value="active">Active</option>
            <option value="inactive">Retired</option>
            <option value="all">All</option>
          </Select>
        </div>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading ? (
          <Spinner />
        ) : !data?.items.length ? (
          <EmptyState title="No products found">
            {canEdit && 'Add your first product with “New product”.'}
          </EmptyState>
        ) : (
          <Table
            head={
              <>
                <Th>Product</Th>
                <Th>Size / Thickness Spec</Th>
                <Th>Kind</Th>
                <Th>HSN</Th>
                <Th right>GST</Th>
                <Th>Unit</Th>
                <Th right>Retail</Th>
                <Th right>Wholesale</Th>
              </>
            }
          >
            {data.items.map((p) => {
              const spec = formatProductSpec(p);
              return (
                <tr
                  key={p.id}
                  className={canEdit ? 'cursor-pointer hover:bg-slate-50' : ''}
                  onClick={() => canEdit && setEditing(p)}
                >
                  <Td>
                    <p className="font-medium text-slate-900">{p.name}</p>
                    <p className="text-xs text-slate-500">{p.sku}</p>
                  </Td>
                  <Td>
                    {spec ? (
                      <Badge tone="blue">{spec}</Badge>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="capitalize">{p.kind}</span>{' '}
                    {!p.isActive && <Badge>Retired</Badge>}
                  </Td>
                  <Td>{p.hsnCode}</Td>
                  <Td right>{Number(p.gstRate)}%</Td>
                  <Td>{p.unitCode}</Td>
                  <Td right>{formatMoney(p.retailPrice)}</Td>
                  <Td right>{formatMoney(p.wholesalePrice)}</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

type FormState = {
  sku: string;
  name: string;
  kind: ProductKind;
  hsnCode: string;
  gstRate: string;
  unitCode: string;
  measure: string;
  length: string;
  lengthUnit: 'inch' | 'mm' | 'cm' | 'ft' | 'm';
  thicknessMm: string;
  pcsPerBox: string;
  finish: string;
  retailPrice: string;
  wholesalePrice: string;
  reorderLevel: string;
  trackInventory: boolean;
  isActive: boolean;
};

function ProductForm({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: reference } = useReference();
  const [form, setForm] = useState<FormState>(() => ({
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    kind: product?.kind ?? 'hardware',
    hsnCode: product?.hsnCode ?? KIND_DEFAULTS.hardware.hsnCode,
    gstRate: product ? String(Number(product.gstRate)) : '18',
    unitCode: product?.unitCode ?? KIND_DEFAULTS.hardware.unitCode,
    measure: product?.measure ?? KIND_DEFAULTS.hardware.measure,
    length:
      typeof product?.attributes?.length === 'string'
        ? product.attributes.length
        : product?.attributes?.length
          ? String(product.attributes.length)
          : '',
    lengthUnit: (product?.attributes?.lengthUnit as FormState['lengthUnit']) ?? 'inch',
    thicknessMm: product?.thicknessMm ? String(Number(product.thicknessMm)) : '',
    pcsPerBox: product?.attributes?.pcsPerBox ? String(product.attributes.pcsPerBox) : '',
    finish: typeof product?.attributes?.finish === 'string' ? product.attributes.finish : '',
    retailPrice: product ? String(Number(product.retailPrice)) : '',
    wholesalePrice: product ? String(Number(product.wholesalePrice)) : '',
    reorderLevel: product ? String(Number(product.reorderLevel)) : '0',
    trackInventory: product?.trackInventory ?? true,
    isActive: product?.isActive ?? true,
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // On a new product, switching the kind switches the defaults too.
  function changeKind(kind: ProductKind) {
    if (product) return set('kind', kind);
    setForm((f) => ({ ...f, kind, ...KIND_DEFAULTS[kind] }));
  }

  const previewSpec = formatProductSpec({
    thicknessMm: form.thicknessMm || null,
    attributes: {
      length: form.length.trim(),
      lengthUnit: form.lengthUnit,
      pcsPerBox: form.pcsPerBox ? Number(form.pcsPerBox) : undefined,
      finish: form.finish.trim(),
    },
  });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    const attributes: Record<string, unknown> = { ...(product?.attributes ?? {}) };
    if (form.length.trim()) {
      attributes.length = form.length.trim();
      attributes.lengthUnit = form.lengthUnit;
    } else {
      delete attributes.length;
      delete attributes.lengthUnit;
    }
    if (form.pcsPerBox.trim() && Number(form.pcsPerBox) > 0) {
      attributes.pcsPerBox = Number(form.pcsPerBox);
    } else {
      delete attributes.pcsPerBox;
    }
    if (form.finish.trim()) {
      attributes.finish = form.finish.trim();
    } else {
      delete attributes.finish;
    }

    const body = {
      sku: form.sku.trim(),
      name: form.name.trim(),
      kind: form.kind,
      hsnCode: form.hsnCode.trim(),
      gstRate: form.gstRate,
      unitCode: form.unitCode,
      measure: form.measure,
      thicknessMm: form.thicknessMm || null,
      attributes,
      retailPrice: form.retailPrice || '0',
      wholesalePrice: form.wholesalePrice || '0',
      reorderLevel: form.reorderLevel || '0',
      trackInventory: form.trackInventory,
    };
    try {
      if (product) {
        await api(`/v1/products/${product.id}`, {
          method: 'PATCH',
          body: { ...body, isActive: form.isActive, version: product.version },
        });
      } else {
        await api('/v1/products', { method: 'POST', body });
      }
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await queryClient.invalidateQueries({ queryKey: ['stock'] });
      toast(product ? 'Product updated' : 'Product added');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(err.fieldErrors);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={product ? `Edit ${product.name}` : 'New product'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="product-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="product-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error && (
          <div className="sm:col-span-2">
            <ErrorBanner message={error} />
          </div>
        )}
        <Input
          label="Product name"
          required
          autoFocus
          placeholder="e.g. T Bracket / Patch Fitting / Toughened Glass"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          error={errors.name}
          wrapperClassName="sm:col-span-2"
        />
        <Input
          label="SKU / item code"
          required
          placeholder="e.g. TB-7IN-8MM"
          value={form.sku}
          onChange={(e) => set('sku', e.target.value)}
          error={errors.sku}
        />
        <Select
          label="Kind"
          value={form.kind}
          onChange={(e) => changeKind(e.target.value as ProductKind)}
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
        <Select
          label="How is it sold / stocked?"
          value={form.measure}
          onChange={(e) => set('measure', e.target.value)}
        >
          {MEASURES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
        <Select
          label="Stock & billing unit"
          value={form.unitCode}
          onChange={(e) => set('unitCode', e.target.value)}
          error={errors.unitCode}
        >
          {reference?.units.map((u) => (
            <option key={u.code} value={u.code}>
              {u.name} ({u.code})
            </option>
          ))}
        </Select>

        {form.kind !== 'service' && (
          <div className="rounded-lg bg-slate-50 p-3.5 ring-1 ring-slate-200 sm:col-span-2">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold tracking-wide text-slate-600 uppercase">
                  Size, Length, Thickness &amp; Box Packing (e.g. 7 inch &amp; 8 mm T-Bracket)
                </p>
                <p className="text-xs text-slate-500">
                  Shown in Stock, Product Search, and printed on GST Bills.
                </p>
              </div>
              {previewSpec && <Badge tone="blue">{previewSpec}</Badge>}
            </div>

            <div className="grid gap-3 sm:grid-cols-4">
              <Input
                label="Length / Size"
                inputMode="decimal"
                placeholder="e.g. 7"
                value={form.length}
                onChange={(e) => set('length', e.target.value)}
              />
              <Select
                label="Length unit"
                value={form.lengthUnit}
                onChange={(e) => set('lengthUnit', e.target.value as FormState['lengthUnit'])}
              >
                {LENGTH_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </Select>
              <Input
                label="Thickness (mm)"
                inputMode="decimal"
                placeholder="e.g. 8"
                value={form.thicknessMm}
                onChange={(e) => set('thicknessMm', e.target.value)}
                error={errors.thicknessMm}
              />
              <Input
                label="Pcs per Box (optional)"
                inputMode="numeric"
                placeholder="e.g. 20"
                hint="If packed in boxes"
                value={form.pcsPerBox}
                onChange={(e) => set('pcsPerBox', e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="mt-3">
              <Input
                label="Finish / Material / Grade (optional)"
                placeholder="e.g. SS 304, Heavy Duty, Matt Black, Zinc"
                value={form.finish}
                onChange={(e) => set('finish', e.target.value)}
              />
            </div>
          </div>
        )}

        <Input
          label="HSN code"
          required
          inputMode="numeric"
          value={form.hsnCode}
          onChange={(e) => set('hsnCode', e.target.value)}
          error={errors.hsnCode}
          hint="4, 6 or 8 digits"
        />
        <Select
          label="GST rate"
          value={form.gstRate}
          onChange={(e) => set('gstRate', e.target.value)}
          error={errors.gstRate}
        >
          {['0', '0.25', '3', '5', '12', '18', '28', '40'].map((r) => (
            <option key={r} value={r}>
              {r}%
            </option>
          ))}
        </Select>
        <Input
          label="Retail price (B2C)"
          inputMode="decimal"
          placeholder="0.00"
          value={form.retailPrice}
          onChange={(e) => set('retailPrice', e.target.value)}
          error={errors.retailPrice}
          hint={`Per ${form.unitCode}, before GST`}
        />
        <Input
          label="Wholesale price (B2B)"
          inputMode="decimal"
          placeholder="0.00"
          value={form.wholesalePrice}
          onChange={(e) => set('wholesalePrice', e.target.value)}
          error={errors.wholesalePrice}
          hint={`Per ${form.unitCode}, before GST`}
        />
        <Input
          label="Reorder level"
          inputMode="decimal"
          value={form.reorderLevel}
          onChange={(e) => set('reorderLevel', e.target.value)}
          error={errors.reorderLevel}
          hint="Warn when stock falls to this"
        />
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="inline-flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.trackInventory}
              onChange={(e) => set('trackInventory', e.target.checked)}
              className="size-4 rounded border-slate-300"
            />
            Track stock
          </label>
          {product && (
            <label className="inline-flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => set('isActive', e.target.checked)}
                className="size-4 rounded border-slate-300"
              />
              Active (untick to retire)
            </label>
          )}
        </div>
      </form>
    </Modal>
  );
}
