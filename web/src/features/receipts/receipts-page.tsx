import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, IndianRupee } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import type { InvoiceSummary, Page, Party, PaymentMode, Receipt } from '../../api/types';
import { useCan } from '../../app/auth';
import { useCurrentBranch, useStateName } from '../../app/shop-data';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
  useToast,
} from '../../components/ui';
import { formatDate, rupees, todayIso } from '../../lib/format';
import { ReasonDialog, useDocumentActions } from '../documents/actions';
import { AllocationEditor, allocationRows } from '../documents/allocation-editor';
import { CustomerPicker } from '../documents/pickers';
import { PAYMENT_MODES, SelectedParty } from '../invoices/new-invoice-page';

const MODE_LABEL = Object.fromEntries(PAYMENT_MODES.map((m) => [m.value, m.label]));

/** Money received from customers. */
export function ReceiptsPage() {
  const canSell = useCan('sell');
  const [receiving, setReceiving] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['receipts'],
    queryFn: () => api<Page<Receipt>>('/v1/receipts?pageSize=100'),
  });

  return (
    <>
      <PageHeader
        title="Receipts"
        subtitle="Payments received from customers"
        actions={
          canSell && (
            <Button icon={<IndianRupee className="size-4" />} onClick={() => setReceiving(true)}>
              Receive payment
            </Button>
          )
        }
      />
      <Card>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading ? (
          <Spinner />
        ) : !data?.items.length ? (
          <EmptyState title="No payments received yet" />
        ) : (
          <Table
            head={
              <>
                <Th>Receipt</Th>
                <Th>Date</Th>
                <Th>From</Th>
                <Th>Mode</Th>
                <Th>Reference</Th>
                <Th right>Amount</Th>
                <Th>Status</Th>
              </>
            }
          >
            {data.items.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => setViewing(r.id)}
              >
                <Td className="font-medium text-slate-900">{r.receiptNo ?? 'Draft'}</Td>
                <Td>{formatDate(r.receiptDate)}</Td>
                <Td>{r.partyName ?? 'Walk-in'}</Td>
                <Td>{MODE_LABEL[r.mode]}</Td>
                <Td>{r.referenceNo}</Td>
                <Td right>{rupees(r.amount)}</Td>
                <Td>
                  <StatusBadge status={r.status} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {receiving && <ReceivePaymentModal onClose={() => setReceiving(false)} />}
      {viewing && <ReceiptModal id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function ReceivePaymentModal({ onClose }: { onClose: () => void }) {
  const { branch } = useCurrentBranch();
  const stateName = useStateName();
  const queryClient = useQueryClient();
  const toast = useToast();
  const key = useRef(crypto.randomUUID());
  const [customer, setCustomer] = useState<Party | null>(null);
  const [amount, setAmount] = useState('');
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayIso());
  const [settlementType, setSettlementType] = useState<'fifo' | 'manual' | 'advance'>('fifo');
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = useQuery({
    queryKey: ['invoices', 'unpaid', customer?.id],
    queryFn: () =>
      api<Page<InvoiceSummary>>(
        `/v1/sales-invoices?partyId=${customer!.id}&unpaid=true&pageSize=200`,
      ),
    enabled: !!customer,
  });
  // Oldest first, as bills are usually settled.
  const bills = [...(open.data?.items ?? [])].reverse().map((i) => ({
    id: i.id,
    number: i.invoiceNo,
    date: i.invoiceDate,
    total: i.grandTotal,
    balanceDue: i.balanceDue,
  }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!branch || !customer) return;
    setBusy(true);
    setError(null);
    try {
      const isFifo = settlementType === 'fifo';
      const isManual = settlementType === 'manual';
      const receipt = await api<Receipt>('/v1/receipts', {
        method: 'POST',
        headers: { 'idempotency-key': key.current },
        body: {
          branchId: branch.id,
          partyId: customer.id,
          mode,
          amount,
          receiptDate: date,
          ...(reference.trim() && { referenceNo: reference.trim() }),
          allocations: isManual ? allocationRows(allocations, 'invoiceId') : [],
          autoKnockoff: isFifo,
          post: true,
        },
      });
      for (const k of ['receipts', 'invoices', 'invoice', 'dashboard', 'party', 'parties']) {
        await queryClient.invalidateQueries({ queryKey: [k] });
      }
      toast(`Receipt ${receipt.receiptNo} saved`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) key.current = crypto.randomUUID();
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Receive payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="receive-form" loading={busy} disabled={!customer}>
            Save receipt
          </Button>
        </>
      }
    >
      <form id="receive-form" onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        {customer ? (
          <SelectedParty party={customer} stateName={stateName} onClear={() => setCustomer(null)} />
        ) : (
          <CustomerPicker onPick={setCustomer} autoFocus />
        )}
        <div className="grid gap-3 sm:grid-cols-4">
          <Input
            label="Amount (₹)"
            required
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Select
            label="Mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as PaymentMode)}
          >
            {PAYMENT_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
          <Input
            label="Reference"
            placeholder="UTR / cheque no."
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {customer &&
          (open.isLoading ? (
            <Spinner />
          ) : bills.length > 0 ? (
            <div className="space-y-3 rounded-lg border border-slate-200 p-3 bg-slate-50/60">
              <p className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                Settlement Method ({bills.length} pending bill{bills.length > 1 ? 's' : ''})
              </p>
              <div className="grid gap-2 sm:grid-cols-3">
                <label
                  className={`flex cursor-pointer flex-col rounded-md border p-2.5 text-xs transition ${
                    settlementType === 'fifo'
                      ? 'border-brand-600 bg-brand-50/40 text-brand-900 font-medium'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <input
                      type="radio"
                      name="settlementType"
                      checked={settlementType === 'fifo'}
                      onChange={() => setSettlementType('fifo')}
                      className="text-brand-600"
                    />
                    <span>FIFO Auto-Knockoff</span>
                  </div>
                  <span className="mt-1 text-[11px] text-slate-500">
                    Settles oldest pending bills first; any excess goes to Advance Wallet.
                  </span>
                </label>

                <label
                  className={`flex cursor-pointer flex-col rounded-md border p-2.5 text-xs transition ${
                    settlementType === 'manual'
                      ? 'border-brand-600 bg-brand-50/40 text-brand-900 font-medium'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <input
                      type="radio"
                      name="settlementType"
                      checked={settlementType === 'manual'}
                      onChange={() => setSettlementType('manual')}
                      className="text-brand-600"
                    />
                    <span>Manual Selection</span>
                  </div>
                  <span className="mt-1 text-[11px] text-slate-500">
                    Pick exact amounts for specific bills.
                  </span>
                </label>

                <label
                  className={`flex cursor-pointer flex-col rounded-md border p-2.5 text-xs transition ${
                    settlementType === 'advance'
                      ? 'border-brand-600 bg-brand-50/40 text-brand-900 font-medium'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-semibold">
                    <input
                      type="radio"
                      name="settlementType"
                      checked={settlementType === 'advance'}
                      onChange={() => setSettlementType('advance')}
                      className="text-brand-600"
                    />
                    <span>Customer Advance</span>
                  </div>
                  <span className="mt-1 text-[11px] text-slate-500">
                    Leave full amount in Advance Wallet without settling existing bills.
                  </span>
                </label>
              </div>

              {settlementType === 'manual' && (
                <div className="pt-2">
                  <AllocationEditor
                    amount={amount}
                    bills={bills}
                    value={allocations}
                    onChange={setAllocations}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900">
              <span className="font-semibold">Advance Payment:</span> Customer has no unpaid bills. This receipt will be kept in their Advance Wallet to settle future invoices.
            </div>
          ))}
      </form>
    </Modal>
  );
}

function ReceiptModal({ id, onClose }: { id: string; onClose: () => void }) {
  const canCancel = useCan('cancelSales');
  const actions = useDocumentActions();
  const [cancelling, setCancelling] = useState(false);
  const { data: r } = useQuery({
    queryKey: ['receipts', id],
    queryFn: () => api<Receipt>(`/v1/receipts/${id}`),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={r ? `Receipt ${r.receiptNo ?? '(draft)'}` : 'Receipt'}
      footer={
        r?.status === 'posted' && canCancel ? (
          <Button
            variant="danger"
            icon={<Ban className="size-4" />}
            onClick={() => setCancelling(true)}
          >
            Cancel receipt
          </Button>
        ) : undefined
      }
    >
      {!r ? (
        <Spinner />
      ) : (
        <div className="space-y-3 text-sm">
          {actions.error && <ErrorBanner message={actions.error} />}
          <p>
            <StatusBadge status={r.status} />{' '}
            <span className="ml-2 text-slate-600">{formatDate(r.receiptDate)}</span>
          </p>
          <p className="num text-2xl font-semibold text-slate-900">{rupees(r.amount)}</p>
          <p className="text-slate-600">
            {MODE_LABEL[r.mode]} {r.referenceNo && `· ${r.referenceNo}`}
          </p>
          {r.cancelReason && <ErrorBanner message={`Cancelled: ${r.cancelReason}`} />}
          {!!r.allocations?.length && (
            <div>
              <p className="mb-1 font-medium text-slate-700">Applied Initially to</p>
              <ul className="divide-y divide-slate-100 rounded-md ring-1 ring-slate-200">
                {r.allocations.map((a) => (
                  <li key={a.invoiceId} className="flex justify-between px-3 py-2">
                    <Link
                      to={`/invoices/${a.invoiceId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {a.invoiceNo}
                    </Link>
                    <span className="num">{rupees(a.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!!r.advanceAllocations?.length && (
            <div>
              <p className="mb-1 font-medium text-slate-700">Settled via Advance / FIFO</p>
              <ul className="divide-y divide-slate-100 rounded-md ring-1 ring-slate-200">
                {r.advanceAllocations.map((a, i) => (
                  <li key={`${a.invoiceId}-${i}`} className="flex justify-between px-3 py-2">
                    <Link
                      to={`/invoices/${a.invoiceId}`}
                      className="text-brand-700 hover:underline"
                    >
                      {a.invoiceNo}
                    </Link>
                    <span className="num text-emerald-700">+{rupees(a.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.unallocatedAmount && Number(r.unallocatedAmount) > 0 ? (
            <div className="flex items-center justify-between rounded-md bg-emerald-50 p-3 border border-emerald-200 text-xs text-emerald-900">
              <span className="font-semibold">Remaining in Customer Wallet:</span>
              <span className="num text-sm font-bold text-emerald-700">{rupees(r.unallocatedAmount)}</span>
            </div>
          ) : null}
        </div>
      )}
      {cancelling && (
        <ReasonDialog
          title="Cancel this receipt?"
          description="Use this when a cheque bounces or the payment was entered by mistake. The bills it paid become unpaid again."
          confirmLabel="Cancel receipt"
          onClose={() => setCancelling(false)}
          onConfirm={(reason) =>
            actions.run(
              'cancel',
              () => api(`/v1/receipts/${id}/cancel`, { method: 'POST', body: { reason } }),
              'Receipt cancelled',
            )
          }
        />
      )}
    </Modal>
  );
}
