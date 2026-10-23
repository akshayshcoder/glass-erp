import { useQuery } from '@tanstack/react-query';
import { Ban, IndianRupee } from 'lucide-react';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import type {
  Page,
  Party,
  PaymentMode,
  PurchaseBillSummary,
  SupplierPayment,
} from '../../api/types';
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
} from '../../components/ui';
import { formatDate, rupees, todayIso } from '../../lib/format';
import { ReasonDialog, useDocumentActions } from '../documents/actions';
import { AllocationEditor, allocationRows } from '../documents/allocation-editor';
import { SupplierPicker } from '../documents/pickers';
import { PAYMENT_MODES, SelectedParty } from '../invoices/new-invoice-page';

const MODE_LABEL = Object.fromEntries(PAYMENT_MODES.map((m) => [m.value, m.label]));

/** Money paid to suppliers. */
export function SupplierPaymentsPage() {
  const canPay = useCan('paySuppliers');
  const [paying, setPaying] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['supplier-payments'],
    queryFn: () => api<Page<SupplierPayment>>('/v1/supplier-payments?pageSize=100'),
  });

  return (
    <>
      <PageHeader
        title="Supplier payments"
        subtitle="Money paid to suppliers"
        actions={
          canPay && (
            <Button icon={<IndianRupee className="size-4" />} onClick={() => setPaying(true)}>
              Pay supplier
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
          <EmptyState title="No payments made yet" />
        ) : (
          <Table
            head={
              <>
                <Th>Voucher</Th>
                <Th>Date</Th>
                <Th>Supplier</Th>
                <Th>Mode</Th>
                <Th>Reference</Th>
                <Th right>Amount</Th>
                <Th>Status</Th>
              </>
            }
          >
            {data.items.map((p) => (
              <tr
                key={p.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => setViewing(p.id)}
              >
                <Td className="font-medium text-slate-900">{p.paymentNo ?? 'Draft'}</Td>
                <Td>{formatDate(p.paymentDate)}</Td>
                <Td>{p.supplierName}</Td>
                <Td>{MODE_LABEL[p.mode]}</Td>
                <Td>{p.referenceNo}</Td>
                <Td right>{rupees(p.amount)}</Td>
                <Td>
                  <StatusBadge status={p.status} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {paying && <PaySupplierModal onClose={() => setPaying(false)} />}
      {viewing && <PaymentModal id={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

/** Pay a supplier and apply the payment to their open bills. */
export function PaySupplierModal({
  supplier: initialSupplier,
  initialAmount = '',
  initialAllocations = {},
  onClose,
}: {
  supplier?: { id: string; name: string };
  initialAmount?: string;
  initialAllocations?: Record<string, string>;
  onClose: () => void;
}) {
  const { branch } = useCurrentBranch();
  const stateName = useStateName();
  const actions = useDocumentActions();
  const key = useRef(crypto.randomUUID());
  const [supplier, setSupplier] = useState<Pick<Party, 'id' | 'name'> | Party | null>(
    initialSupplier ?? null,
  );
  const [amount, setAmount] = useState(initialAmount);
  const [mode, setMode] = useState<PaymentMode>('bank_transfer');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(todayIso());
  const [allocations, setAllocations] = useState<Record<string, string>>(initialAllocations);

  const open = useQuery({
    queryKey: ['purchase-bills', 'unpaid', supplier?.id],
    queryFn: () =>
      api<Page<PurchaseBillSummary>>(
        `/v1/purchase-bills?supplierId=${supplier!.id}&unpaid=true&pageSize=200`,
      ),
    enabled: !!supplier,
  });
  const bills = [...(open.data?.items ?? [])].reverse().map((b) => ({
    id: b.id,
    number: `${b.docNo} (${b.supplierInvoiceNo})`,
    date: b.entryDate,
    total: b.grandTotal,
    balanceDue: b.balanceDue,
  }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!branch || !supplier) return;
    const ok = await actions.run(
      'pay',
      () =>
        api('/v1/supplier-payments', {
          method: 'POST',
          headers: { 'idempotency-key': key.current },
          body: {
            branchId: branch.id,
            supplierId: supplier.id,
            mode,
            amount,
            paymentDate: date,
            ...(reference.trim() && { referenceNo: reference.trim() }),
            allocations: allocationRows(allocations, 'billId'),
            post: true,
          },
        }).catch((err) => {
          if (err instanceof ApiError) key.current = crypto.randomUUID();
          throw err;
        }),
      'Payment saved',
    );
    if (ok) onClose();
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Pay supplier"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="pay-supplier-form"
            loading={actions.busy === 'pay'}
            disabled={!supplier}
          >
            Save payment
          </Button>
        </>
      }
    >
      <form id="pay-supplier-form" onSubmit={submit} className="space-y-4">
        {actions.error && <ErrorBanner message={actions.error} />}
        {supplier ? (
          'stateCode' in supplier ? (
            <SelectedParty
              party={supplier}
              stateName={stateName}
              onClear={() => setSupplier(null)}
            />
          ) : (
            <p className="rounded-md bg-slate-50 px-4 py-3 font-medium text-slate-900 ring-1 ring-slate-200">
              {supplier.name}
            </p>
          )
        ) : (
          <SupplierPicker onPick={setSupplier} autoFocus />
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
        {supplier &&
          (open.isLoading ? (
            <Spinner />
          ) : (
            <AllocationEditor
              amount={amount}
              bills={bills}
              value={allocations}
              onChange={setAllocations}
            />
          ))}
      </form>
    </Modal>
  );
}

function PaymentModal({ id, onClose }: { id: string; onClose: () => void }) {
  const canPay = useCan('paySuppliers');
  const actions = useDocumentActions();
  const [cancelling, setCancelling] = useState(false);
  const { data: p } = useQuery({
    queryKey: ['supplier-payments', id],
    queryFn: () => api<SupplierPayment>(`/v1/supplier-payments/${id}`),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={p ? `Payment ${p.paymentNo ?? '(draft)'}` : 'Payment'}
      footer={
        p?.status === 'posted' && canPay ? (
          <Button
            variant="danger"
            icon={<Ban className="size-4" />}
            onClick={() => setCancelling(true)}
          >
            Cancel payment
          </Button>
        ) : undefined
      }
    >
      {!p ? (
        <Spinner />
      ) : (
        <div className="space-y-3 text-sm">
          {actions.error && <ErrorBanner message={actions.error} />}
          <p>
            <StatusBadge status={p.status} />{' '}
            <span className="ml-2 text-slate-600">{formatDate(p.paymentDate)}</span>
          </p>
          <p className="num text-2xl font-semibold text-slate-900">{rupees(p.amount)}</p>
          <p className="text-slate-600">
            {MODE_LABEL[p.mode]} {p.referenceNo && `· ${p.referenceNo}`}
          </p>
          {p.cancelReason && <ErrorBanner message={`Cancelled: ${p.cancelReason}`} />}
          {!!p.allocations?.length && (
            <ul className="divide-y divide-slate-100 rounded-md ring-1 ring-slate-200">
              {p.allocations.map((a) => (
                <li key={a.billId} className="flex justify-between px-3 py-2">
                  <Link to={`/purchases/${a.billId}`} className="text-brand-700 hover:underline">
                    {a.docNo} ({a.supplierInvoiceNo})
                  </Link>
                  <span className="num">{rupees(a.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {cancelling && (
        <ReasonDialog
          title="Cancel this payment?"
          description="The bills it paid become unpaid again."
          confirmLabel="Cancel payment"
          onClose={() => setCancelling(false)}
          onConfirm={(reason) =>
            actions.run(
              'cancel',
              () => api(`/v1/supplier-payments/${id}/cancel`, { method: 'POST', body: { reason } }),
              'Payment cancelled',
            )
          }
        />
      )}
    </Modal>
  );
}
