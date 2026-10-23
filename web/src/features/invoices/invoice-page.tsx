import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  IndianRupee,
  Pencil,
  Printer,
  Trash2,
  Undo2,
} from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ApiError, api, apiFetch, errorMessage } from '../../api/client';
import type { Invoice, PaymentMode } from '../../api/types';
import { useAuth, useCan } from '../../app/auth';
import { useBranches, useStateName } from '../../app/shop-data';
import {
  Badge,
  Button,
  Card,
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
import { formatDate, formatMoney, formatQty, isZero, rupees } from '../../lib/format';
import { docCustomerLabel } from '../../lib/party-type';
import { BranchModal, formatBranchAddress } from '../settings/branches-page';

/** One invoice: details, print, post, take payment, cancel. */
export function InvoicePage() {
  const { id } = useParams() as { id: string };
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const stateName = useStateName();
  const { shopName } = useAuth();
  const { data: branches } = useBranches();
  const canManageShop = useCan('manageShop'); // Owner only
  const canSell = useCan('sell');
  const canCancel = useCan('cancelSales');
  const canCreditNote = useCan('creditNotes');
  const [dialog, setDialog] = useState<'pay' | 'cancel' | null>(null);
  const [editingBranch, setEditingBranch] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: inv, error } = useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api<Invoice>(`/v1/sales-invoices/${id}`),
  });

  if (error) return <ErrorBanner message={errorMessage(error)} />;
  if (!inv) return <Spinner />;
  const branch = branches?.find((b) => b.id === inv.branchId) ?? null;

  const refresh = async () => {
    await Promise.all(
      ['invoice', 'invoices', 'dashboard', 'stock', 'parties', 'party'].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );
  };

  async function run(name: string, action: () => Promise<unknown>, done: string) {
    setBusy(name);
    setActionError(null);
    try {
      await action();
      await refresh();
      toast(done);
    } catch (err) {
      setActionError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function print() {
    // Open the tab synchronously (popup blockers), then load the PDF into it.
    const tab = window.open('', '_blank');
    try {
      const res = await apiFetch(`/v1/sales-invoices/${id}/pdf`);
      const url = URL.createObjectURL(await res.blob());
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      setActionError(errorMessage(err));
    }
  }

  const interState = inv.placeOfSupply !== inv.sellerStateCode;
  const hasDue =
    inv.status === 'posted' && !isZero(inv.balanceDue) && !inv.balanceDue.startsWith('-');
  const cancellable =
    inv.status === 'posted' && isZero(inv.amountPaid) && isZero(inv.amountCredited);

  return (
    <>
      <Link
        to="/invoices"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> Invoices
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {inv.invoiceNo ?? 'Draft bill'} <StatusBadge status={inv.status} />
          </span>
        }
        subtitle={`${formatDate(inv.invoiceDate)} · ${inv.supplyType.toUpperCase()} · Place of supply ${stateName(inv.placeOfSupply)}`}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Printer className="size-4" />}
              onClick={() => void print()}
            >
              {inv.status === 'draft' ? 'Preview PDF' : 'Print'}
            </Button>
            {inv.status === 'draft' && canSell && (
              <>
                <Button
                  variant="secondary"
                  icon={<Trash2 className="size-4" />}
                  loading={busy === 'delete'}
                  onClick={() =>
                    void run(
                      'delete',
                      async () => {
                        await api(`/v1/sales-invoices/${id}`, { method: 'DELETE' });
                        navigate('/invoices');
                      },
                      'Draft deleted',
                    )
                  }
                >
                  Delete draft
                </Button>
                <Button
                  icon={<CheckCircle2 className="size-4" />}
                  loading={busy === 'post'}
                  onClick={() =>
                    void run(
                      'post',
                      () => api(`/v1/sales-invoices/${id}/post`, { method: 'POST' }),
                      'Bill posted',
                    )
                  }
                >
                  Post bill
                </Button>
              </>
            )}
            {hasDue && canSell && (
              <Button icon={<IndianRupee className="size-4" />} onClick={() => setDialog('pay')}>
                Record payment
              </Button>
            )}
            {inv.status === 'posted' && canCreditNote && (
              <Button
                variant="secondary"
                icon={<Undo2 className="size-4" />}
                onClick={() => navigate(`/credit-notes/new?invoiceId=${inv.id}`)}
              >
                Return / credit note
              </Button>
            )}
            {cancellable && canCancel && (
              <Button
                variant="danger"
                icon={<Ban className="size-4" />}
                onClick={() => setDialog('cancel')}
              >
                Cancel bill
              </Button>
            )}
          </>
        }
      />

      {actionError && (
        <div className="mb-4">
          <ErrorBanner message={actionError} />
        </div>
      )}
      {inv.status === 'cancelled' && (
        <div className="mb-4">
          <ErrorBanner message={`Cancelled: ${inv.cancelReason ?? ''}`} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
                Billed from (Shop)
              </p>
              <p className="mt-1 font-medium text-slate-900">
                {shopName} {branch ? `· ${branch.name}` : ''}
              </p>
            </div>
            {canManageShop && branch && (
              <Button
                variant="ghost"
                icon={<Pencil className="size-3.5" />}
                onClick={() => setEditingBranch(true)}
              >
                Edit
              </Button>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {branch && (branch.address || branch.city)
              ? formatBranchAddress(branch, stateName)
              : stateName(inv.sellerStateCode)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {[
              inv.sellerGstin ? `GSTIN ${inv.sellerGstin}` : 'Unregistered',
              branch?.phone ? `Ph: ${branch.phone}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Bill to</p>
          <p className="mt-1 font-medium text-slate-900">
            {inv.partyId ? (
              <Link to={`/parties/${inv.partyId}`} className="hover:underline">
                {docCustomerLabel(inv.customerName, inv.customerType)}
              </Link>
            ) : (
              docCustomerLabel(inv.customerName, inv.customerType)
            )}
          </p>
          <p className="text-sm text-slate-500">
            {[
              inv.customerGstin ? `GSTIN ${inv.customerGstin}` : null,
              inv.customerPhone,
              inv.billingAddress,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </Card>
        <Card className="p-5">
          <dl className="num space-y-1 text-sm">
            <Row label="Total" value={rupees(inv.grandTotal)} strong />
            <Row label="Paid" value={rupees(inv.amountPaid)} />
            {!isZero(inv.amountCredited) && (
              <Row label="Credit notes" value={rupees(inv.amountCredited)} />
            )}
            {inv.status === 'posted' && (
              <div className="flex justify-between border-t border-slate-200 pt-1.5">
                <dt className="text-slate-600">Balance due</dt>
                <dd
                  className={
                    hasDue ? 'font-semibold text-amber-700' : 'font-semibold text-emerald-700'
                  }
                >
                  {hasDue ? rupees(inv.balanceDue) : <Badge tone="green">Paid</Badge>}
                </dd>
              </div>
            )}
          </dl>
        </Card>
      </div>
      {editingBranch && branch && (
        <BranchModal branch={branch} onClose={() => setEditingBranch(false)} />
      )}

      <Card className="mt-6">
        <Table
          head={
            <>
              <Th>#</Th>
              <Th>Item</Th>
              <Th>HSN</Th>
              <Th right>Qty</Th>
              <Th right>Rate</Th>
              <Th right>Taxable</Th>
              <Th right>GST</Th>
              <Th right>Amount</Th>
            </>
          }
        >
          {inv.lines.map((l) => (
            <tr key={l.lineNo}>
              <Td className="text-slate-400">{l.lineNo}</Td>
              <Td className="text-slate-900">{l.description}</Td>
              <Td>{l.hsnCode}</Td>
              <Td right>
                {formatQty(l.qty)} {l.unitCode}
              </Td>
              <Td right>{formatMoney(l.rate)}</Td>
              <Td right>{formatMoney(l.taxableValue)}</Td>
              <Td right>{Number(l.gstRate)}%</Td>
              <Td right className="font-medium">
                {formatMoney(l.lineTotal)}
              </Td>
            </tr>
          ))}
        </Table>
        <div className="flex justify-end border-t border-slate-200 p-5">
          <dl className="num w-64 space-y-1 text-sm">
            <Row label="Taxable value" value={formatMoney(inv.taxableValue)} />
            {interState ? (
              <Row label="IGST" value={formatMoney(inv.igstAmount)} />
            ) : (
              <>
                <Row label="CGST" value={formatMoney(inv.cgstAmount)} />
                <Row label="SGST" value={formatMoney(inv.sgstAmount)} />
              </>
            )}
            <Row label="Round off" value={formatMoney(inv.roundOff)} />
            <div className="border-t border-slate-200 pt-1">
              <Row label="Total" value={rupees(inv.grandTotal)} strong />
            </div>
          </dl>
        </div>
      </Card>

      {dialog === 'pay' && (
        <PaymentModal invoice={inv} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog === 'cancel' && (
        <CancelModal
          onClose={() => setDialog(null)}
          onConfirm={(reason) =>
            run(
              'cancel',
              () => api(`/v1/sales-invoices/${id}/cancel`, { method: 'POST', body: { reason } }),
              'Bill cancelled. Stock restored.',
            )
          }
        />
      )}
    </>
  );
}

function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${strong ? 'text-base font-semibold text-slate-900' : 'text-slate-600'}`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function PaymentModal({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const key = useRef(crypto.randomUUID());
  const [amount, setAmount] = useState(invoice.balanceDue);
  const [mode, setMode] = useState<PaymentMode>('cash');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/v1/receipts', {
        method: 'POST',
        headers: { 'idempotency-key': key.current },
        body: {
          branchId: invoice.branchId,
          partyId: invoice.partyId,
          mode,
          amount,
          ...(reference.trim() && { referenceNo: reference.trim() }),
          allocations: [{ invoiceId: invoice.id, amount }],
          post: true,
        },
      });
      await onDone();
      toast(`Payment of ₹${formatMoney(amount)} recorded`);
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
      onClose={onClose}
      title="Record payment"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="pay-form" loading={busy}>
            Save payment
          </Button>
        </>
      }
    >
      <form id="pay-form" onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Input
          label="Amount (₹)"
          required
          autoFocus
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          hint={`Due: ₹${formatMoney(invoice.balanceDue)}`}
        />
        <Select label="Mode" value={mode} onChange={(e) => setMode(e.target.value as PaymentMode)}>
          <option value="cash">Cash</option>
          <option value="upi">UPI</option>
          <option value="card">Card</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="cheque">Cheque</option>
        </Select>
        <Input
          label="Reference (UTR / cheque no.)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
      </form>
    </Modal>
  );
}

function CancelModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="Cancel this bill?"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep bill
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!reason.trim()}
            onClick={async () => {
              setBusy(true);
              await onConfirm(reason.trim());
              setBusy(false);
              onClose();
            }}
          >
            Cancel bill
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-600">
        Stock goes back and the customer's balance is reversed. The bill number stays in the records
        as cancelled. After the month's GST return is filed, use a credit note instead.
      </p>
      <Input
        label="Reason"
        required
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  );
}
