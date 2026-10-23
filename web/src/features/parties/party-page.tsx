import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileText, Pencil, Wallet, Zap } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { CustomerWallet, KnockoffResult, Ledger, Party } from '../../api/types';
import { useCan } from '../../app/auth';
import { useStateName } from '../../app/shop-data';
import {
  Button,
  Card,
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
import { formatDate, formatMoney, isNegative, rupees, todayIso } from '../../lib/format';
import { partyLabel } from '../../lib/party-type';
import { PartyForm } from './parties-page';

const ENTRY_LABELS: Record<string, string> = {
  opening: 'Opening balance',
  sales_invoice: 'Sales invoice',
  sales_invoice_cancel: 'Invoice cancelled',
  receipt: 'Payment received',
  receipt_cancel: 'Receipt cancelled',
  credit_note: 'Credit note',
  credit_note_cancel: 'Credit note cancelled',
  purchase: 'Purchase bill',
  purchase_cancel: 'Purchase cancelled',
  supplier_payment: 'Payment made',
  supplier_payment_cancel: 'Payment cancelled',
};

/** One customer/supplier: details and their account statement. */
export function PartyPage() {
  const { id } = useParams() as { id: string };
  const stateName = useStateName();
  const toast = useToast();
  const queryClient = useQueryClient();
  const canEdit = useCan('manageParties');
  const canOpening = useCan('postOpeningBalance');
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(false);
  const [activeTab, setActiveTab] = useState<'statement' | 'unpaid' | 'wallet'>('statement');
  const [knockingOff, setKnockingOff] = useState(false);
  const [settlingInvoiceId, setSettlingInvoiceId] = useState<string | null>(null);

  const party = useQuery({
    queryKey: ['party', id],
    queryFn: () => api<Party>(`/v1/parties/${id}`),
  });
  const ledger = useQuery({
    queryKey: ['party', id, 'ledger'],
    queryFn: () => api<Ledger>(`/v1/parties/${id}/ledger`),
  });
  const wallet = useQuery({
    queryKey: ['party', id, 'wallet'],
    queryFn: () => api<CustomerWallet>(`/v1/parties/${id}/wallet`),
    enabled: party.data?.kind !== 'supplier',
  });

  if (party.error) return <ErrorBanner message={errorMessage(party.error)} />;
  if (!party.data) return <Spinner />;
  const p = party.data;
  const owes = isNegative(p.balance) ? 'You owe them' : 'They owe you';

  const wBalance = Number(wallet.data?.walletBalance ?? p.walletBalance ?? '0');
  const outstanding = Number(wallet.data?.totalOutstanding ?? p.totalOutstanding ?? '0');
  const canKnockoff = wBalance > 0 && outstanding > 0;

  async function handleAutoKnockoff() {
    setKnockingOff(true);
    try {
      const res = await api<KnockoffResult>(`/v1/parties/${id}/auto-knockoff`, { method: 'POST' });
      for (const k of ['party', 'ledger', 'invoices', 'receipts']) {
        await queryClient.invalidateQueries({ queryKey: [k] });
      }
      toast(`Settled ₹${res.totalSettled} across ${res.settledCount} invoice(s) via FIFO!`);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setKnockingOff(false);
    }
  }

  async function handleSettleInvoice(invId: string) {
    setSettlingInvoiceId(invId);
    try {
      const res = await api<{ appliedAmount: string; remainingDue: string }>(
        `/v1/sales-invoices/${invId}/apply-advance`,
        { method: 'POST' },
      );
      for (const k of ['party', 'ledger', 'invoices', 'receipts']) {
        await queryClient.invalidateQueries({ queryKey: [k] });
      }
      toast(`Applied ₹${res.appliedAmount} advance to invoice! (Balance due: ₹${res.remainingDue})`);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setSettlingInvoiceId(null);
    }
  }

  return (
    <>
      <Link
        to="/parties"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> Customers & suppliers
      </Link>
      <PageHeader
        title={partyLabel(p)}
        subtitle={[
          p.kind,
          p.gstin ? `GSTIN ${p.gstin}` : 'Unregistered',
          stateName(p.stateCode),
          p.phone,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            {canOpening && ledger.data?.entries.every((e) => e.type !== 'opening') && (
              <Button variant="secondary" onClick={() => setOpening(true)}>
                Opening balance
              </Button>
            )}
            {canEdit && (
              <Button
                variant="secondary"
                icon={<Pencil className="size-4" />}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
            )}
          </>
        }
      />

      {/* Financial 360 Overview Cards */}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500 uppercase">{owes}</p>
          <p className="num mt-1 text-2xl font-bold text-slate-900">
            {rupees(p.balance?.replace('-', ''))}
          </p>
          <p className="mt-1 text-xs text-slate-500">Net ledger position</p>
        </Card>

        <Card className="p-4 border-l-4 border-emerald-500">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500 uppercase">Advance in Wallet</p>
            <Wallet className="size-4 text-emerald-600" />
          </div>
          <p className="num mt-1 text-2xl font-bold text-emerald-700">
            {rupees(wallet.data?.walletBalance ?? p.walletBalance ?? '0.00')}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {wallet.data?.unallocatedReceiptsCount ?? 0} advance receipt(s)
          </p>
        </Card>

        <Card className="p-4 border-l-4 border-amber-500">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-slate-500 uppercase">Invoices Outstanding</p>
            <FileText className="size-4 text-amber-600" />
          </div>
          <p className="num mt-1 text-2xl font-bold text-amber-800">
            {rupees(wallet.data?.totalOutstanding ?? p.totalOutstanding ?? '0.00')}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {wallet.data?.unpaidInvoices?.length ?? p.unpaidInvoicesCount ?? 0} unpaid bill(s)
          </p>
        </Card>

        <Card className="p-4">
          <p className="text-xs font-medium text-slate-500 uppercase">Credit Limit</p>
          <p className="num mt-1 text-2xl font-bold text-slate-900">
            {p.creditLimit && Number(p.creditLimit) > 0 ? rupees(p.creditLimit) : 'No Limit'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Available:{' '}
            {wallet.data?.availableCredit !== null && wallet.data?.availableCredit !== undefined
              ? rupees(wallet.data.availableCredit)
              : 'Unlimited'}
          </p>
        </Card>
      </div>

      {/* Auto-Knockoff Callout Banner */}
      {canKnockoff && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-lg bg-emerald-50 border border-emerald-200 p-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <Zap className="size-5" />
            </div>
            <div>
              <p className="font-semibold text-emerald-950">
                Advance Knock-off Available (FIFO)
              </p>
              <p className="text-sm text-emerald-800">
                Customer has ₹{wallet.data?.walletBalance} advance and ₹{wallet.data?.totalOutstanding} in pending bills.
              </p>
            </div>
          </div>
          <Button
            onClick={handleAutoKnockoff}
            loading={knockingOff}
            className="bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
          >
            Auto-Settle Bills (FIFO)
          </Button>
        </div>
      )}

      {/* Tabs navigation */}
      <div className="mb-4 flex gap-2 border-b border-slate-200 pb-2">
        <button
          type="button"
          onClick={() => setActiveTab('statement')}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            activeTab === 'statement'
              ? 'bg-brand-50 text-brand-700 font-semibold shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Statement / Ledger
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('unpaid')}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            activeTab === 'unpaid'
              ? 'bg-brand-50 text-brand-700 font-semibold shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Unpaid Bills ({wallet.data?.unpaidInvoices?.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('wallet')}
          className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
            activeTab === 'wallet'
              ? 'bg-brand-50 text-brand-700 font-semibold shadow-xs'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          Advance Receipts ({wallet.data?.receipts?.length ?? 0})
        </button>
      </div>

      {activeTab === 'statement' && (
        <Card>
          <h2 className="px-4 py-3 text-sm font-semibold text-slate-900">Account Statement</h2>
          {ledger.isLoading ? (
            <Spinner />
          ) : !ledger.data?.entries.length ? (
            <EmptyState title="No transactions yet" />
          ) : (
            <Table
              head={
                <>
                  <Th>Date</Th>
                  <Th>Particulars</Th>
                  <Th>Ref.</Th>
                  <Th right>Debit</Th>
                  <Th right>Credit</Th>
                  <Th right>Balance</Th>
                </>
              }
            >
              {ledger.data.entries.map((e) => (
                <tr key={e.id}>
                  <Td>{formatDate(e.date)}</Td>
                  <Td>
                    <p>{ENTRY_LABELS[e.type] ?? e.type}</p>
                    {e.narration && <p className="text-xs text-slate-500">{e.narration}</p>}
                  </Td>
                  <Td>
                    {e.refId && e.type.startsWith('sales_invoice') ? (
                      <Link to={`/invoices/${e.refId}`} className="text-brand-700 hover:underline">
                        {e.refNo}
                      </Link>
                    ) : (
                      e.refNo
                    )}
                  </Td>
                  <Td right>{Number(e.debit) ? formatMoney(e.debit) : ''}</Td>
                  <Td right>{Number(e.credit) ? formatMoney(e.credit) : ''}</Td>
                  <Td right className="font-medium">
                    {formatMoney(e.balance)}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {activeTab === 'unpaid' && (
        <Card>
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <h2 className="text-sm font-semibold text-slate-900">Pending Invoices</h2>
            {canKnockoff && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Zap className="size-3.5" />}
                onClick={handleAutoKnockoff}
                loading={knockingOff}
              >
                FIFO Knockoff
              </Button>
            )}
          </div>
          {!wallet.data?.unpaidInvoices?.length ? (
            <EmptyState title="No unpaid bills" />
          ) : (
            <Table
              head={
                <>
                  <Th>Bill #</Th>
                  <Th>Date</Th>
                  <Th right>Total</Th>
                  <Th right>Paid</Th>
                  <Th right>Balance Due</Th>
                  <Th right>Action</Th>
                </>
              }
            >
              {wallet.data.unpaidInvoices.map((inv) => (
                <tr key={inv.id}>
                  <Td className="font-medium">
                    <Link to={`/invoices/${inv.id}`} className="text-brand-700 hover:underline">
                      {inv.invoiceNo}
                    </Link>
                  </Td>
                  <Td>{formatDate(inv.invoiceDate)}</Td>
                  <Td right>{rupees(inv.grandTotal)}</Td>
                  <Td right>{rupees(inv.amountPaid)}</Td>
                  <Td right className="font-semibold text-amber-700">
                    {rupees(inv.balanceDue)}
                  </Td>
                  <Td right>
                    {wBalance > 0 ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={settlingInvoiceId === inv.id}
                        onClick={() => handleSettleInvoice(inv.id)}
                      >
                        Settle from Advance
                      </Button>
                    ) : (
                      <span className="text-xs text-slate-400">No advance</span>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {activeTab === 'wallet' && (
        <Card>
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Advance Receipts in Wallet</h2>
              <p className="text-xs text-slate-500">
                Payments received that have unallocated amounts available for billing.
              </p>
            </div>
            <span className="num font-bold text-emerald-700">
              Total Wallet: {rupees(wallet.data?.walletBalance ?? '0.00')}
            </span>
          </div>
          {!wallet.data?.receipts?.length ? (
            <EmptyState title="No advance receipts" />
          ) : (
            <Table
              head={
                <>
                  <Th>Receipt #</Th>
                  <Th>Date</Th>
                  <Th right>Total Received</Th>
                  <Th right>Allocated</Th>
                  <Th right>Unallocated Advance</Th>
                  <Th>Notes</Th>
                </>
              }
            >
              {wallet.data.receipts.map((rcpt) => (
                <tr key={rcpt.id}>
                  <Td className="font-medium text-slate-900">{rcpt.receiptNo ?? '(Draft)'}</Td>
                  <Td>{formatDate(rcpt.receiptDate)}</Td>
                  <Td right>{rupees(rcpt.amount)}</Td>
                  <Td right>{rupees(rcpt.allocatedAmount)}</Td>
                  <Td right className="font-semibold text-emerald-700">
                    {rupees(rcpt.unallocatedAmount)}
                  </Td>
                  <Td className="text-xs text-slate-500">{rcpt.notes ?? '—'}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      )}

      {editing && <PartyForm party={p} onClose={() => setEditing(false)} />}
      {opening && <OpeningBalanceModal partyId={p.id} onClose={() => setOpening(false)} />}
    </>
  );
}

function OpeningBalanceModal({ partyId, onClose }: { partyId: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'they' | 'we'>('they');
  const [asOf, setAsOf] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const signed = direction === 'they' ? amount : `-${amount}`;
      await api(`/v1/parties/${partyId}/opening-balance`, {
        method: 'POST',
        body: { amount: signed, asOf },
      });
      await queryClient.invalidateQueries({ queryKey: ['party', partyId] });
      await queryClient.invalidateQueries({ queryKey: ['parties'] });
      toast('Opening balance saved');
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
      title="Opening balance"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="opening-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="opening-form" onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-500">
          The balance from your old books. It can be entered only once.
        </p>
        {error && <ErrorBanner message={error} />}
        <div className="flex gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="radio"
              checked={direction === 'they'}
              onChange={() => setDirection('they')}
            />{' '}
            They owe us
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" checked={direction === 'we'} onChange={() => setDirection('we')} />{' '}
            We owe them
          </label>
        </div>
        <Input
          label="Amount (₹)"
          required
          inputMode="decimal"
          autoFocus
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          label="As of"
          type="date"
          required
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
        />
      </form>
    </Modal>
  );
}
