import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import type { CreditNote, Invoice, PricedDocument } from '../../api/types';
import {
  Button,
  Card,
  Checkbox,
  ErrorBanner,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  useToast,
} from '../../components/ui';
import { formatMoney, formatQty, rupees, todayIso } from '../../lib/format';
import { sumDecimal } from '../../lib/money';
import { TotalsRows } from '../documents/document-view';
import { useDocumentPreview } from '../documents/line-items';

/*
 * Credit note against a posted invoice: a return of goods, or a value
 * correction (rate difference, discount…). Customer, place of supply, HSN and
 * GST rate always come from the invoice; the server checks the GST rules
 * (no more than sold, no more than the invoice value, time limit).
 */

const REASONS = [
  { value: 'sales_return', label: 'Goods returned' },
  { value: 'rate_difference', label: 'Rate difference' },
  { value: 'discount', label: 'Discount after sale' },
  { value: 'deficiency', label: 'Deficiency in goods' },
  { value: 'other', label: 'Other' },
] as const;
type Reason = (typeof REASONS)[number]['value'];

interface SoldProduct {
  productId: string;
  description: string;
  unitCode: string;
  qty: string;
  rate: string;
}

export function NewCreditNotePage() {
  const [params] = useSearchParams();
  const invoiceId = params.get('invoiceId') ?? '';
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = useRef(crypto.randomUUID());

  const [reason, setReason] = useState<Reason>('sales_return');
  const [restock, setRestock] = useState(true);
  const [noteDate, setNoteDate] = useState(todayIso());
  const [remarks, setRemarks] = useState('');
  /** productId -> qty (returns) or taxable amount (value notes). */
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const invoice = useQuery({
    queryKey: ['invoice', invoiceId],
    queryFn: () => api<Invoice>(`/v1/sales-invoices/${invoiceId}`),
    enabled: !!invoiceId,
  });

  /** One row per product on the invoice (quantities summed). */
  const sold = useMemo<SoldProduct[]>(() => {
    const byProduct = new Map<string, SoldProduct>();
    for (const l of invoice.data?.lines ?? []) {
      const existing = byProduct.get(l.productId);
      if (existing) existing.qty = sumDecimal([existing.qty, l.qty], 3);
      else
        byProduct.set(l.productId, {
          productId: l.productId,
          description: l.description.replace(/ \(.*\)$/, ''),
          unitCode: l.unitCode,
          qty: l.qty,
          rate: l.rate,
        });
    }
    return [...byProduct.values()];
  }, [invoice.data]);

  const isReturn = reason === 'sales_return';
  const lines = Object.entries(values)
    .filter(([, v]) => /^\d*\.?\d+$/.test(v) && Number(v) > 0)
    .map(([productId, v]) => (isReturn ? { productId, qty: v } : { productId, amount: v }));
  const body = {
    invoiceId,
    reason,
    restock: isReturn && restock,
    noteDate,
    ...(remarks.trim() && { remarks: remarks.trim() }),
    lines,
  };
  const preview = useDocumentPreview<PricedDocument>(
    '/v1/credit-notes/preview',
    body,
    lines.length > 0,
  );
  const interState = !!invoice.data && invoice.data.placeOfSupply !== invoice.data.sellerStateCode;

  async function save() {
    setSaveError(null);
    if (lines.length === 0)
      return setSaveError(isReturn ? 'Enter the quantity returned.' : 'Enter an amount.');
    setSaving(true);
    try {
      const note = await api<CreditNote>('/v1/credit-notes', {
        method: 'POST',
        headers: { 'idempotency-key': key.current },
        body: { ...body, post: true },
      });
      for (const k of [
        'credit-notes',
        'invoice',
        'invoices',
        'stock',
        'dashboard',
        'party',
        'parties',
      ]) {
        await queryClient.invalidateQueries({ queryKey: [k] });
      }
      toast(`Credit note ${note.noteNo} saved`);
      navigate(`/credit-notes/${note.id}`);
    } catch (err) {
      if (err instanceof ApiError) key.current = crypto.randomUUID();
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (invoice.error) return <ErrorBanner message={errorMessage(invoice.error)} />;
  if (!invoice.data) return <Spinner />;
  const inv = invoice.data;

  return (
    <>
      <Link
        to={`/invoices/${inv.id}`}
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> {inv.invoiceNo}
      </Link>
      <PageHeader title="Credit note" subtitle={`Against ${inv.invoiceNo} · ${inv.customerName}`} />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card className="grid gap-4 p-4 sm:grid-cols-3">
            <Select
              label="Reason"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value as Reason);
                setValues({});
              }}
            >
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
            <Input
              label="Date"
              type="date"
              value={noteDate}
              onChange={(e) => setNoteDate(e.target.value)}
            />
            <div className="flex items-end pb-2">
              {isReturn && (
                <Checkbox
                  label="Goods are saleable (back to stock)"
                  checked={restock}
                  onChange={(e) => setRestock(e.target.checked)}
                />
              )}
            </div>
          </Card>

          <Card>
            <Table
              head={
                <>
                  <Th>Item</Th>
                  <Th right>Sold</Th>
                  <Th right>Rate</Th>
                  <Th right>{isReturn ? 'Qty returned' : 'Credit (before GST)'}</Th>
                </>
              }
            >
              {sold.map((s) => (
                <tr key={s.productId}>
                  <Td className="text-slate-900">{s.description}</Td>
                  <Td right>
                    {formatQty(s.qty)} {s.unitCode}
                  </Td>
                  <Td right>{formatMoney(s.rate)}</Td>
                  <Td right>
                    <input
                      inputMode="decimal"
                      aria-label={`${isReturn ? 'Qty returned' : 'Credit amount'} for ${s.description}`}
                      placeholder={isReturn ? '0' : '0.00'}
                      value={values[s.productId] ?? ''}
                      onChange={(e) =>
                        setValues({
                          ...values,
                          [s.productId]: e.target.value.replace(/[^\d.]/g, ''),
                        })
                      }
                      className="num w-28 rounded-md border-0 px-2 py-1.5 text-right ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
                    />
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Input label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </div>

        <div className="lg:sticky lg:top-0 lg:self-start">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Credit</h2>
            {preview.error && lines.length > 0 && (
              <div className="mb-3">
                <ErrorBanner message={errorMessage(preview.error)} />
              </div>
            )}
            <dl className="num space-y-1.5 text-sm">
              <TotalsRows
                totals={lines.length ? preview.data : undefined}
                interState={interState}
              />
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              Invoice total {rupees(inv.grandTotal)} · already credited {rupees(inv.amountCredited)}
            </p>
            {saveError && (
              <div className="mt-4">
                <ErrorBanner message={saveError} />
              </div>
            )}
            <Button className="mt-5 w-full" loading={saving} onClick={() => void save()}>
              Save credit note
            </Button>
          </Card>
        </div>
      </div>
    </>
  );
}
