import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import type { Party, PricedDocument, PurchaseBill } from '../../api/types';
import { useCurrentBranch, useStateName } from '../../app/shop-data';
import {
  Button,
  Card,
  ErrorBanner,
  Input,
  PageHeader,
  Spinner,
  useToast,
} from '../../components/ui';
import { todayIso } from '../../lib/format';
import { TotalsRows } from '../documents/document-view';
import {
  LineItems,
  type Row,
  rowFromLine,
  useDocumentPreview,
  useLineItems,
  usePricedLines,
} from '../documents/line-items';
import { SupplierPicker } from '../documents/pickers';
import { SelectedParty } from '../invoices/new-invoice-page';

/*
 * Enter a supplier's bill (goods received). Posting adds the goods to stock and
 * records what we owe the supplier. Rates default to the last purchase price.
 */
export function PurchaseFormPage() {
  const { id } = useParams();
  const existing = useQuery({
    queryKey: ['purchase-bill', id],
    queryFn: () => api<PurchaseBill>(`/v1/purchase-bills/${id}`),
    enabled: !!id,
  });
  if (id && existing.error) return <ErrorBanner message={errorMessage(existing.error)} />;
  if (id && !existing.data) return <Spinner />;
  return <PurchaseForm bill={existing.data ?? null} />;
}

function PurchaseForm({ bill }: { bill: PurchaseBill | null }) {
  const { branch } = useCurrentBranch();
  const stateName = useStateName();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const items = useLineItems(bill?.lines.map(rowFromLine) ?? ([] as Row[]), { preferQty: true });
  const key = useRef(crypto.randomUUID());

  const [supplier, setSupplier] = useState<Party | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(bill?.supplierId ?? null);
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState(bill?.supplierInvoiceNo ?? '');
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState(
    bill?.supplierInvoiceDate ?? todayIso(),
  );
  const [entryDate, setEntryDate] = useState(bill?.entryDate ?? todayIso());
  const [saving, setSaving] = useState<'draft' | 'post' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const branchId = bill?.branchId ?? branch?.id;
  const hasLines = items.complete.length > 0;
  const preview = useDocumentPreview<
    PricedDocument & { supplierStateCode: string; buyerStateCode: string }
  >(
    '/v1/purchase-bills/preview',
    { branchId, supplierId, lines: items.complete },
    !!branchId && !!supplierId && hasLines,
  );
  const priced = usePricedLines(items, preview.data?.lines);
  const interState =
    !!preview.data && preview.data.supplierStateCode !== preview.data.buyerStateCode;

  async function save(post: boolean) {
    setSaveError(null);
    if (!supplierId) return setSaveError('Choose the supplier.');
    if (!supplierInvoiceNo.trim()) return setSaveError("Enter the supplier's bill number.");
    if (!items.allComplete) return setSaveError('Add products and complete every line.');
    setSaving(post ? 'post' : 'draft');
    const body = {
      branchId,
      supplierId,
      supplierInvoiceNo: supplierInvoiceNo.trim(),
      supplierInvoiceDate,
      entryDate,
      lines: items.complete,
    };
    try {
      let saved: PurchaseBill;
      if (bill) {
        saved = await api<PurchaseBill>(`/v1/purchase-bills/${bill.id}`, {
          method: 'PUT',
          body: { ...body, version: bill.version },
        });
        if (post)
          saved = await api<PurchaseBill>(`/v1/purchase-bills/${bill.id}/post`, { method: 'POST' });
      } else {
        saved = await api<PurchaseBill>('/v1/purchase-bills', {
          method: 'POST',
          headers: { 'idempotency-key': key.current },
          body: { ...body, post },
        });
      }
      for (const k of [
        'purchase-bills',
        'purchase-bill',
        'stock',
        'dashboard',
        'parties',
        'party',
        'products',
      ]) {
        await queryClient.invalidateQueries({ queryKey: [k] });
      }
      toast(post ? `Purchase ${saved.docNo} saved, stock updated` : 'Draft saved');
      navigate(`/purchases/${saved.id}`);
    } catch (err) {
      if (err instanceof ApiError) key.current = crypto.randomUUID();
      setSaveError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <Link
        to="/purchases"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> Purchases
      </Link>
      <PageHeader
        title={bill ? 'Edit purchase bill' : 'New purchase bill'}
        subtitle="Enter the supplier's bill as received"
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-slate-900">Supplier</h2>
            {supplier ? (
              <SelectedParty
                party={supplier}
                stateName={stateName}
                onClear={() => {
                  setSupplier(null);
                  setSupplierId(null);
                }}
              />
            ) : supplierId && bill ? (
              <div className="flex items-center justify-between rounded-md bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
                <p className="font-medium text-slate-900">{bill.supplierName}</p>
                <button
                  className="text-sm text-brand-700 hover:underline"
                  onClick={() => setSupplierId(null)}
                >
                  Change
                </button>
              </div>
            ) : (
              <SupplierPicker
                autoFocus
                onPick={(p) => {
                  setSupplier(p);
                  setSupplierId(p.id);
                }}
              />
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label="Supplier's bill no."
                required
                value={supplierInvoiceNo}
                onChange={(e) => setSupplierInvoiceNo(e.target.value)}
              />
              <Input
                label="Supplier's bill date"
                type="date"
                value={supplierInvoiceDate}
                onChange={(e) => setSupplierInvoiceDate(e.target.value)}
              />
              <Input
                label="Goods received on"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </div>
          </Card>
          <Card>
            <LineItems items={items} priced={priced} />
          </Card>
        </div>
        <div className="lg:sticky lg:top-0 lg:self-start">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Summary</h2>
            {!supplierId && (
              <p className="mb-3 text-xs text-slate-500">Choose the supplier to see GST.</p>
            )}
            {preview.error && hasLines && (
              <div className="mb-3">
                <ErrorBanner message={errorMessage(preview.error)} />
              </div>
            )}
            <dl className="num space-y-1.5 text-sm">
              <TotalsRows
                totals={hasLines && supplierId ? preview.data : undefined}
                interState={interState}
              />
            </dl>
            {saveError && (
              <div className="mt-4">
                <ErrorBanner message={saveError} />
              </div>
            )}
            <div className="mt-5 flex flex-col gap-2">
              <Button
                onClick={() => void save(true)}
                loading={saving === 'post'}
                disabled={!!saving}
              >
                Save &amp; add to stock
              </Button>
              <Button
                variant="secondary"
                onClick={() => void save(false)}
                loading={saving === 'draft'}
                disabled={!!saving}
              >
                Save as draft
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
