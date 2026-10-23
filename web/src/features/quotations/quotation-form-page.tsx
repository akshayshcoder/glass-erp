import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { InvoicePreview, Party, Quotation } from '../../api/types';
import { useCurrentBranch, useStateName } from '../../app/shop-data';
import {
  Button,
  Card,
  ErrorBanner,
  Input,
  PageHeader,
  Spinner,
  Textarea,
  useToast,
} from '../../components/ui';
import { todayIso } from '../../lib/format';
import { docCustomerLabel } from '../../lib/party-type';
import { TotalsRows } from '../documents/document-view';
import {
  LineItems,
  type Row,
  rowFromLine,
  useDocumentPreview,
  useLineItems,
  usePricedLines,
} from '../documents/line-items';
import { CustomerPicker } from '../documents/pickers';
import { SelectedParty } from '../invoices/new-invoice-page';

/** New quotation, or editing a draft one (/quotations/:id/edit). */
export function QuotationFormPage() {
  const { id } = useParams();
  const existing = useQuery({
    queryKey: ['quotation', id],
    queryFn: () => api<Quotation>(`/v1/quotations/${id}`),
    enabled: !!id,
  });
  if (id && existing.error) return <ErrorBanner message={errorMessage(existing.error)} />;
  if (id && !existing.data) return <Spinner />;
  return <QuotationForm quotation={existing.data ?? null} />;
}

function QuotationForm({ quotation }: { quotation: Quotation | null }) {
  const { branch } = useCurrentBranch();
  const stateName = useStateName();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const items = useLineItems(quotation?.lines.map(rowFromLine) ?? ([] as Row[]));

  const [customer, setCustomer] = useState<Party | null>(null);
  const [keepCustomer, setKeepCustomer] = useState(!!quotation?.partyId);
  const [walkInName, setWalkInName] = useState(
    quotation && !quotation.partyId ? quotation.customerName : '',
  );
  const [walkInPhone, setWalkInPhone] = useState(quotation?.customerPhone ?? '');
  const [quoteDate, setQuoteDate] = useState(quotation?.quoteDate ?? todayIso());
  const [validUntil, setValidUntil] = useState(quotation?.validUntil ?? '');
  const [terms, setTerms] = useState(quotation?.terms ?? '');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const partyId = customer?.id ?? (keepCustomer ? quotation?.partyId : null);
  const header = {
    branchId: quotation?.branchId ?? branch?.id,
    ...(partyId
      ? { partyId }
      : {
          ...(walkInName.trim() && { customerName: walkInName.trim() }),
          ...(walkInPhone.trim() && { customerPhone: walkInPhone.trim() }),
        }),
    quoteDate,
    ...(validUntil && { validUntil }),
    ...(terms.trim() && { terms: terms.trim() }),
  };
  const hasLines = items.complete.length > 0;
  // Quotations are priced exactly like invoices.
  const preview = useDocumentPreview<InvoicePreview>(
    '/v1/sales-invoices/preview',
    {
      branchId: header.branchId,
      ...(partyId ? { partyId } : {}),
      invoiceDate: quoteDate,
      lines: items.complete,
    },
    !!header.branchId && hasLines,
  );
  const priced = usePricedLines(items, preview.data?.lines);
  const interState = !!preview.data && preview.data.placeOfSupply !== preview.data.sellerStateCode;

  async function save() {
    setSaveError(null);
    if (!items.allComplete) return setSaveError('Add products and complete every line.');
    setSaving(true);
    try {
      const body = { ...header, lines: items.complete };
      const saved = quotation
        ? await api<Quotation>(`/v1/quotations/${quotation.id}`, {
            method: 'PUT',
            body: { ...body, version: quotation.version },
          })
        : await api<Quotation>('/v1/quotations', { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: ['quotations'] });
      await queryClient.invalidateQueries({ queryKey: ['quotation'] });
      toast('Quotation saved');
      navigate(`/quotations/${saved.id}`);
    } catch (err) {
      setSaveError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Link
        to="/quotations"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> Quotations
      </Link>
      <PageHeader
        title={quotation ? 'Edit quotation' : 'New quotation'}
        subtitle="Prices are before GST; GST is added below."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <Card className="space-y-3 p-4">
            <h2 className="text-sm font-semibold text-slate-900">Customer</h2>
            {customer ? (
              <SelectedParty
                party={customer}
                stateName={stateName}
                onClear={() => setCustomer(null)}
              />
            ) : keepCustomer && quotation ? (
              <div className="flex items-center justify-between rounded-md bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
                <p className="font-medium text-slate-900">
                  {docCustomerLabel(quotation.customerName, quotation.customerType)}
                </p>
                <button
                  className="text-sm text-brand-700 hover:underline"
                  onClick={() => setKeepCustomer(false)}
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <CustomerPicker onPick={setCustomer} />
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <UserRound className="size-3.5" /> or a new / walk-in customer:
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    placeholder="Name"
                    aria-label="Customer name"
                    value={walkInName}
                    onChange={(e) => setWalkInName(e.target.value)}
                  />
                  <Input
                    placeholder="Phone"
                    aria-label="Customer phone"
                    value={walkInPhone}
                    onChange={(e) => setWalkInPhone(e.target.value)}
                  />
                </div>
              </>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Date"
                type="date"
                value={quoteDate}
                onChange={(e) => setQuoteDate(e.target.value)}
              />
              <Input
                label="Valid until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </div>
          </Card>
          <Card>
            <LineItems items={items} priced={priced} />
          </Card>
          <Textarea
            label="Terms"
            rows={3}
            placeholder="e.g. Fitting charges extra. 50% advance with order. Delivery in 7 days."
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
          />
        </div>
        <div className="lg:sticky lg:top-0 lg:self-start">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-slate-900">Summary</h2>
            {preview.error && hasLines && (
              <div className="mb-3">
                <ErrorBanner message={errorMessage(preview.error)} />
              </div>
            )}
            <dl className="num space-y-1.5 text-sm">
              <TotalsRows totals={hasLines ? preview.data : undefined} interState={interState} />
            </dl>
            {saveError && (
              <div className="mt-4">
                <ErrorBanner message={saveError} />
              </div>
            )}
            <Button className="mt-5 w-full" loading={saving} onClick={() => void save()}>
              Save quotation
            </Button>
            <p className="mt-2 text-xs text-slate-500">
              Saved as a draft. Issue it to give it a number.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
