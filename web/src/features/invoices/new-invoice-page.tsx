import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Pencil, UserRound, Wallet, X } from 'lucide-react';
import { type KeyboardEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import type { CustomerWallet, Invoice, InvoicePreview, Party, PaymentMode } from '../../api/types';
import { useAuth, useCan } from '../../app/auth';
import { useCurrentBranch, useStateName } from '../../app/shop-data';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorBanner,
  Input,
  PageHeader,
  Select,
  useToast,
} from '../../components/ui';
import { formatMoney, todayIso } from '../../lib/format';
import { TotalsRows } from '../documents/document-view';
import {
  LineItems,
  useDocumentPreview,
  useLineItems,
  usePricedLines,
} from '../documents/line-items';
import { CustomerPicker } from '../documents/pickers';
import { BranchModal, formatBranchAddress } from '../settings/branches-page';

/*
 * The billing counter screen.
 *
 * The browser never calculates GST: every change is sent (debounced) to
 * POST /v1/sales-invoices/preview and the totals shown are the server's.
 * Saving sends an Idempotency-Key, so a double click or a retry after a
 * network error can never create two bills.
 */

export const PAYMENT_MODES: { value: PaymentMode; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
];

export function NewInvoicePage() {
  const { shopName } = useAuth();
  const canManageShop = useCan('manageShop'); // Owner only
  const { branch } = useCurrentBranch();
  const stateName = useStateName();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const items = useLineItems();

  const [editingBranch, setEditingBranch] = useState(false);
  const [customer, setCustomer] = useState<Party | null>(null);
  const [useAdvance, setUseAdvance] = useState(true);
  const [walkInName, setWalkInName] = useState('');
  const [walkInPhone, setWalkInPhone] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [paidNow, setPaidNow] = useState(true);
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash');
  const [paymentAmount, setPaymentAmount] = useState<string | null>(null); // null = follow the total
  const [saving, setSaving] = useState<'draft' | 'post' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());

  const wallet = useQuery({
    queryKey: ['party', customer?.id, 'wallet'],
    queryFn: () => api<CustomerWallet>(`/v1/parties/${customer!.id}/wallet`),
    enabled: !!customer,
  });

  const header = {
    branchId: branch?.id,
    ...(customer
      ? { partyId: customer.id }
      : {
          ...(walkInName.trim() && { customerName: walkInName.trim() }),
          ...(walkInPhone.trim() && { customerPhone: walkInPhone.trim() }),
        }),
    invoiceDate,
  };
  const hasLines = items.complete.length > 0;
  const preview = useDocumentPreview<InvoicePreview>(
    '/v1/sales-invoices/preview',
    { ...header, lines: items.complete },
    !!branch && hasLines,
  );
  const priced = usePricedLines(items, preview.data?.lines);
  const total = hasLines && preview.data ? preview.data.grandTotal : '0.00';
  
  const walletBalanceNum = Number(wallet.data?.walletBalance ?? '0');
  const totalNum = Number(total);
  const advanceDeduction = useAdvance && walletBalanceNum > 0 ? Math.min(walletBalanceNum, totalNum) : 0;
  const netPayable = Math.max(0, totalNum - advanceDeduction);
  const amountToPay = paymentAmount ?? (netPayable > 0 ? netPayable.toFixed(2) : total);
  const interState = !!preview.data && preview.data.placeOfSupply !== preview.data.sellerStateCode;

  async function save(post: boolean) {
    setSaveError(null);
    if (!branch) return;
    if (items.rows.length === 0) return setSaveError('Add at least one product.');
    if (!items.allComplete) return setSaveError('Complete the quantity or size of every line.');
    setSaving(post ? 'post' : 'draft');
    try {
      const invoice = await api<Invoice>('/v1/sales-invoices', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey.current },
        body: {
          ...header,
          lines: items.complete,
          post,
          ...(post && useAdvance && walletBalanceNum > 0 && { useAdvance: true }),
          ...(post &&
            paidNow &&
            Number(amountToPay) > 0 && { payment: { mode: paymentMode, amount: amountToPay } }),
        },
      });
      idempotencyKey.current = crypto.randomUUID();
      for (const key of ['invoices', 'dashboard', 'stock', 'receipts', 'party', 'parties']) {
        await queryClient.invalidateQueries({ queryKey: [key] });
      }
      toast(post ? `Bill ${invoice.invoiceNo} saved` : 'Draft saved');
      navigate(`/invoices/${invoice.id}`);
    } catch (err) {
      // A validation/business error means this exact request will never succeed:
      // a corrected request must get a new key. Network errors keep the key (safe retry).
      if (err instanceof ApiError) idempotencyKey.current = crypto.randomUUID();
      setSaveError(errorMessage(err));
    } finally {
      setSaving(null);
    }
  }

  const onPageKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save(true);
    }
  };

  return (
    <div onKeyDown={onPageKeyDown}>
      <PageHeader
        title="New bill"
        subtitle={<>Ctrl + Enter to save &amp; post · Enter after a line to add the next product</>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {branch && (
            <Card className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                      Billing from (Shop address)
                    </p>
                    <Badge tone={branch.gstin ? 'blue' : 'gray'}>
                      {branch.gstin ? `GSTIN ${branch.gstin}` : 'Unregistered'}
                    </Badge>
                  </div>
                  <p className="font-semibold text-slate-900">
                    {shopName} · <span className="font-normal text-slate-600">{branch.name} ({branch.code})</span>
                  </p>
                  <p className="flex items-center gap-1.5 text-sm text-slate-600">
                    <MapPin className="size-3.5 shrink-0 text-slate-400" />
                    {branch.address || branch.city ? (
                      formatBranchAddress(branch, stateName)
                    ) : (
                      <span className="text-amber-600">
                        Full shop address not set yet ({stateName(branch.stateCode)})
                      </span>
                    )}
                  </p>
                  {(branch.phone || branch.email) && (
                    <p className="text-xs text-slate-500">
                      {[branch.phone ? `Ph: ${branch.phone}` : null, branch.email]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </div>
                {canManageShop && (
                  <Button
                    variant="secondary"
                    icon={<Pencil className="size-3.5" />}
                    onClick={() => setEditingBranch(true)}
                  >
                    Edit address
                  </Button>
                )}
              </div>
            </Card>
          )}
          {editingBranch && branch && (
            <BranchModal branch={branch} onClose={() => setEditingBranch(false)} />
          )}

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Customer</h2>
              <Input
                type="date"
                aria-label="Bill date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className="w-40"
              />
            </div>
            {customer ? (
              <div className="space-y-3">
                <SelectedParty
                  party={customer}
                  stateName={stateName}
                  onClear={() => setCustomer(null)}
                />
                {walletBalanceNum > 0 && (
                  <div className="flex items-center justify-between rounded-md bg-emerald-50 px-3.5 py-2.5 border border-emerald-200">
                    <div className="flex items-center gap-2">
                      <Wallet className="size-4 text-emerald-600 shrink-0" />
                      <div>
                        <p className="text-xs font-semibold text-emerald-950">
                          Advance in Wallet: ₹{wallet.data?.walletBalance}
                        </p>
                        <p className="text-[11px] text-emerald-800">
                          Available to settle against this invoice.
                        </p>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-xs font-medium text-emerald-900 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useAdvance}
                        onChange={(e) => setUseAdvance(e.target.checked)}
                        className="size-4 rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500"
                      />
                      Apply Advance
                    </label>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <CustomerPicker onPick={setCustomer} />
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <UserRound className="size-3.5" /> or walk-in customer:
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    placeholder="Name (optional)"
                    aria-label="Walk-in name"
                    value={walkInName}
                    onChange={(e) => setWalkInName(e.target.value)}
                  />
                  <Input
                    placeholder="Phone (optional)"
                    aria-label="Walk-in phone"
                    inputMode="tel"
                    value={walkInPhone}
                    onChange={(e) => setWalkInPhone(e.target.value)}
                  />
                </div>
              </div>
            )}
          </Card>

          <Card>
            <LineItems items={items} priced={priced} />
          </Card>
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
              {hasLines && advanceDeduction > 0 && (
                <div className="flex justify-between text-xs font-semibold text-emerald-700 pt-1.5 border-t border-dashed border-emerald-300">
                  <span>Less Advance Wallet:</span>
                  <span>-₹{formatMoney(advanceDeduction.toFixed(2))}</span>
                </div>
              )}
              {hasLines && advanceDeduction > 0 && (
                <div className="flex justify-between text-sm font-bold text-slate-900 pt-1">
                  <span>Net Payable:</span>
                  <span>₹{formatMoney(netPayable.toFixed(2))}</span>
                </div>
              )}
            </dl>
            {preview.data && hasLines && (
              <p className="mt-2 text-xs text-slate-500">
                {preview.data.supplyType.toUpperCase()} · Place of supply{' '}
                {stateName(preview.data.placeOfSupply)}
                {preview.isFetching && ' · updating…'}
              </p>
            )}

            <div className="mt-5 space-y-3 border-t border-slate-200 pt-4">
              <Checkbox
                label="Paid now"
                checked={paidNow}
                onChange={(e) => setPaidNow(e.target.checked)}
              />
              {paidNow && (
                <div className="grid grid-cols-2 gap-2">
                  <Select
                    aria-label="Payment mode"
                    value={paymentMode}
                    onChange={(e) => setPaymentMode(e.target.value as PaymentMode)}
                  >
                    {PAYMENT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </Select>
                  <Input
                    aria-label="Amount received"
                    inputMode="decimal"
                    value={amountToPay}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                  />
                </div>
              )}
            </div>

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
                Save &amp; post bill
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
    </div>
  );
}

/** The chosen customer/supplier with a B2B/B2C badge and a clear button. */
export function SelectedParty({
  party,
  stateName,
  onClear,
}: {
  party: Party;
  stateName: (code: string | null) => string;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-start justify-between rounded-md bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
      <div>
        <p className="font-medium text-slate-900">{party.name}</p>
        <p className="text-xs text-slate-500">
          {party.gstin ? `GSTIN ${party.gstin}` : 'Unregistered'} · {stateName(party.stateCode)}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={party.gstin ? 'blue' : 'gray'}>{party.gstin ? 'B2B' : 'B2C'}</Badge>
        {onClear && (
          <button
            onClick={onClear}
            className="rounded p-1 text-slate-400 hover:bg-slate-200"
            aria-label="Remove"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
