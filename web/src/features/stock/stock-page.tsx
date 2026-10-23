import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { SlidersHorizontal } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { Product, StockItem } from '../../api/types';
import { useCan } from '../../app/auth';
import { useCurrentBranch } from '../../app/shop-data';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorBanner,
  Input,
  Modal,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
  useToast,
} from '../../components/ui';
import { formatProductSpec, formatQty } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { ProductPicker } from '../documents/pickers';

export function StockPage() {
  const { branch } = useCurrentBranch();
  const canAdjust = useCan('adjustStock');
  const [params, setParams] = useSearchParams();
  const lowOnly = params.get('low') === '1';
  const [search, setSearch] = useState('');
  const [adjusting, setAdjusting] = useState(false);
  const q = useDebounced(search.trim(), 250);

  const query = new URLSearchParams({
    ...(branch && { branchId: branch.id }),
    lowOnly: String(lowOnly),
    ...(q && { search: q }),
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['stock', query.toString()],
    queryFn: () => api<{ items: StockItem[] }>(`/v1/stock?${query}`).then((r) => r.items),
    enabled: !!branch,
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Stock"
        subtitle={branch?.name}
        actions={
          canAdjust && (
            <Button
              variant="secondary"
              icon={<SlidersHorizontal className="size-4" />}
              onClick={() => setAdjusting(true)}
            >
              Adjust stock
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap items-center gap-4 border-b border-slate-200 p-4">
          <input
            type="search"
            placeholder="Search product by name, SKU, length or thickness…"
            aria-label="Search stock"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="block min-w-60 flex-1 rounded-md border-0 px-3 py-2 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
          />
          <Checkbox
            label="Only low stock"
            checked={lowOnly}
            onChange={(e) => setParams(e.target.checked ? { low: '1' } : {})}
          />
        </div>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading ? (
          <Spinner />
        ) : !data?.length ? (
          <EmptyState title={lowOnly ? 'Nothing is low on stock' : 'No stock yet'}>
            {!lowOnly && 'Stock appears after a purchase or an opening-stock adjustment.'}
          </EmptyState>
        ) : (
          <Table
            head={
              <>
                <Th>Product</Th>
                <Th>Size / Thickness Spec</Th>
                <Th>Kind</Th>
                <Th right>In stock</Th>
                <Th right>Reorder at</Th>
                <Th />
              </>
            }
          >
            {data.map((s) => {
              const spec = formatProductSpec(s);
              const pcsPerBox = Number(s.attributes?.pcsPerBox || 0);
              const boxCount =
                s.unitCode === 'PCS' && pcsPerBox > 0 ? Number(s.qty) / pcsPerBox : null;
              return (
                <tr key={s.productId}>
                  <Td>
                    <p className="font-medium text-slate-900">{s.name}</p>
                    <p className="text-xs text-slate-500">{s.sku}</p>
                  </Td>
                  <Td>
                    {spec ? (
                      <span className="inline-flex items-center rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-600/20 ring-inset">
                        {spec}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </Td>
                  <Td>
                    <span className="capitalize">{s.kind}</span>
                  </Td>
                  <Td right className="font-medium">
                    <div>
                      {formatQty(s.qty)} {s.unitCode}
                    </div>
                    {boxCount !== null && (
                      <div className="text-xs font-normal text-slate-500">
                        ≈ {Number(boxCount.toFixed(2))} Box{boxCount === 1 ? '' : 'es'}
                      </div>
                    )}
                  </Td>
                  <Td right>{Number(s.reorderLevel) ? formatQty(s.reorderLevel) : ''}</Td>
                  <Td>
                    {s.needsReorder && Number(s.reorderLevel) > 0 && <Badge tone="amber">Low</Badge>}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      {adjusting && branch && (
        <AdjustStockModal branchId={branch.id} onClose={() => setAdjusting(false)} />
      )}
    </>
  );
}

function AdjustStockModal({ branchId, onClose }: { branchId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [product, setProduct] = useState<Product | null>(null);
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [qty, setQty] = useState('');
  const [boxes, setBoxes] = useState('');
  const [reason, setReason] = useState('');
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pcsPerBox = Number(product?.attributes?.pcsPerBox || 0);
  const showBoxHelper = product?.unitCode === 'PCS' && pcsPerBox > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!product) return setError('Choose a product');
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ qty: string }>('/v1/stock/adjustments', {
        method: 'POST',
        body: {
          branchId,
          productId: product.id,
          qtyChange: direction === 'add' ? qty : `-${qty}`,
          reason: reason.trim() || (isOpening ? 'Opening stock' : ''),
          isOpening: direction === 'add' && isOpening,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['stock'] });
      toast(`${product.name}: now ${formatQty(result.qty)} ${product.unitCode}`);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Adjust stock"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="adjust-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="adjust-form" onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Product</p>
          {product ? (
            <div className="flex items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200">
              <div>
                <p className="font-medium text-slate-900">{product.name}</p>
                {formatProductSpec(product) && (
                  <p className="text-xs text-brand-700">{formatProductSpec(product)}</p>
                )}
              </div>
              <button
                type="button"
                className="text-brand-700 hover:underline"
                onClick={() => {
                  setProduct(null);
                  setBoxes('');
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <ProductPicker autoFocus onPick={(p) => setProduct(p)} />
          )}
        </div>
        <div className="flex gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={direction === 'add'}
              onChange={() => setDirection('add')}
            />{' '}
            Add
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={direction === 'remove'}
              onChange={() => setDirection('remove')}
            />{' '}
            Remove (breakage, recount)
          </label>
        </div>
        {showBoxHelper ? (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={`Boxes (1 Box = ${pcsPerBox} PCS)`}
              inputMode="decimal"
              placeholder="e.g. 2"
              value={boxes}
              onChange={(e) => {
                const v = e.target.value;
                setBoxes(v);
                const num = Number(v);
                if (v.trim() !== '' && !Number.isNaN(num)) {
                  setQty(String(num * pcsPerBox));
                }
              }}
            />
            <Input
              label={`Total Quantity (${product.unitCode})`}
              required
              inputMode="decimal"
              value={qty}
              onChange={(e) => {
                const v = e.target.value;
                setQty(v);
                const num = Number(v);
                if (v.trim() !== '' && !Number.isNaN(num)) {
                  setBoxes(String(Number((num / pcsPerBox).toFixed(2))));
                } else {
                  setBoxes('');
                }
              }}
            />
          </div>
        ) : (
          <Input
            label={`Quantity${product ? ` (${product.unitCode})` : ''}`}
            required
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        )}
        {direction === 'add' && (
          <Checkbox
            label="This is opening stock"
            checked={isOpening}
            onChange={(e) => setIsOpening(e.target.checked)}
          />
        )}
        <Input
          label="Reason"
          required={!isOpening}
          placeholder={isOpening ? 'Opening stock' : 'e.g. 2 boxes received / recount'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </form>
    </Modal>
  );
}
