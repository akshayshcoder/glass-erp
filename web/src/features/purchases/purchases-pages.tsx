import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  CheckCircle2,
  IndianRupee,
  PackagePlus,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { Page, PurchaseBill, PurchaseBillSummary } from '../../api/types';
import { useCan } from '../../app/auth';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { formatDate, isZero, rupees } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { ReasonDialog, useDocumentActions } from '../documents/actions';
import { LinesCard, PartyCard, Row } from '../documents/document-view';
import { PaySupplierModal } from './supplier-payments-page';

export function PurchaseBillsPage() {
  const navigate = useNavigate();
  const canPurchase = useCan('purchase');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const q = useDebounced(search.trim(), 250);
  const filters = new URLSearchParams({
    pageSize: '50',
    ...(q && { search: q }),
    ...(status && { status }),
  });

  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['purchase-bills', filters.toString()],
      queryFn: ({ pageParam }) =>
        api<Page<PurchaseBillSummary>>(
          `/v1/purchase-bills?${filters}${pageParam ? `&pageToken=${pageParam}` : ''}`,
        ),
      initialPageParam: '',
      getNextPageParam: (last) => last.nextPageToken ?? undefined,
    });
  const bills = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Purchases"
        subtitle="Supplier bills: goods coming into stock"
        actions={
          canPurchase && (
            <Button
              icon={<PackagePlus className="size-4" />}
              onClick={() => navigate('/purchases/new')}
            >
              New purchase
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
              placeholder="Our number, supplier bill no. or supplier…"
              aria-label="Search purchases"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="block w-full rounded-md border-0 py-2 pr-3 pl-9 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
            />
          </div>
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-36"
          >
            <option value="">All</option>
            <option value="draft">Drafts</option>
            <option value="posted">Posted</option>
            <option value="cancelled">Cancelled</option>
          </Select>
        </div>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading ? (
          <Spinner />
        ) : bills.length === 0 ? (
          <EmptyState title="No purchases yet" />
        ) : (
          <>
            <Table
              head={
                <>
                  <Th>Our no.</Th>
                  <Th>Received</Th>
                  <Th>Supplier</Th>
                  <Th>Their bill</Th>
                  <Th right>Amount</Th>
                  <Th right>To pay</Th>
                  <Th>Status</Th>
                </>
              }
            >
              {bills.map((b) => (
                <tr
                  key={b.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/purchases/${b.id}`)}
                >
                  <Td className="font-medium text-slate-900">{b.docNo ?? 'Draft'}</Td>
                  <Td>{formatDate(b.entryDate)}</Td>
                  <Td>{b.supplierName}</Td>
                  <Td>
                    {b.supplierInvoiceNo}
                    <span className="ml-1 text-xs text-slate-500">
                      {formatDate(b.supplierInvoiceDate)}
                    </span>
                  </Td>
                  <Td right>{rupees(b.grandTotal)}</Td>
                  <Td
                    right
                    className={
                      b.status === 'posted' && !isZero(b.balanceDue)
                        ? 'font-medium text-amber-700'
                        : 'text-slate-400'
                    }
                  >
                    {b.status === 'posted' ? rupees(b.balanceDue) : ''}
                  </Td>
                  <Td>
                    <StatusBadge status={b.status} />
                  </Td>
                </tr>
              ))}
            </Table>
            {hasNextPage && (
              <div className="border-t border-slate-200 p-3 text-center">
                <Button
                  variant="ghost"
                  loading={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

export function PurchaseBillPage() {
  const { id } = useParams() as { id: string };
  const navigate = useNavigate();
  const canPurchase = useCan('purchase');
  const canCancel = useCan('cancelPurchase');
  const canPay = useCan('paySuppliers');
  const actions = useDocumentActions();
  const [dialog, setDialog] = useState<'pay' | 'cancel' | null>(null);
  const { data: b, error } = useQuery({
    queryKey: ['purchase-bill', id],
    queryFn: () => api<PurchaseBill>(`/v1/purchase-bills/${id}`),
  });

  if (error) return <ErrorBanner message={errorMessage(error)} />;
  if (!b) return <Spinner />;
  const due = b.status === 'posted' && !isZero(b.balanceDue);

  return (
    <>
      <Link
        to="/purchases"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> Purchases
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {b.docNo ?? 'Draft purchase'} <StatusBadge status={b.status} />
          </span>
        }
        subtitle={`Received ${formatDate(b.entryDate)} · supplier bill ${b.supplierInvoiceNo} of ${formatDate(b.supplierInvoiceDate)}`}
        actions={
          <>
            {b.status === 'draft' && canPurchase && (
              <>
                <Button
                  variant="secondary"
                  icon={<Trash2 className="size-4" />}
                  loading={actions.busy === 'delete'}
                  onClick={async () => {
                    if (
                      await actions.run(
                        'delete',
                        () => api(`/v1/purchase-bills/${id}`, { method: 'DELETE' }),
                        'Draft deleted',
                      )
                    )
                      navigate('/purchases');
                  }}
                >
                  Delete
                </Button>
                <Button
                  variant="secondary"
                  icon={<Pencil className="size-4" />}
                  onClick={() => navigate(`/purchases/${id}/edit`)}
                >
                  Edit
                </Button>
                <Button
                  icon={<CheckCircle2 className="size-4" />}
                  loading={actions.busy === 'post'}
                  onClick={() =>
                    actions.run(
                      'post',
                      () => api(`/v1/purchase-bills/${id}/post`, { method: 'POST' }),
                      'Posted: stock updated',
                    )
                  }
                >
                  Post
                </Button>
              </>
            )}
            {due && canPay && (
              <Button icon={<IndianRupee className="size-4" />} onClick={() => setDialog('pay')}>
                Pay supplier
              </Button>
            )}
            {b.status === 'posted' && isZero(b.amountPaid) && canCancel && (
              <Button
                variant="danger"
                icon={<Ban className="size-4" />}
                onClick={() => setDialog('cancel')}
              >
                Cancel
              </Button>
            )}
          </>
        }
      />
      {actions.error && (
        <div className="mb-4">
          <ErrorBanner message={actions.error} />
        </div>
      )}
      {b.status === 'cancelled' && (
        <div className="mb-4">
          <ErrorBanner message={`Cancelled: ${b.cancelReason ?? ''}`} />
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <PartyCard
            heading="Supplier"
            name={
              <Link to={`/parties/${b.supplierId}`} className="hover:underline">
                {b.supplierName}
              </Link>
            }
            lines={[
              b.supplierGstin ? `GSTIN ${b.supplierGstin}` : 'Unregistered',
              b.itcEligible ? 'ITC eligible' : 'No ITC',
            ]}
          />
        </div>
        <Card className="p-5">
          <dl className="num space-y-1 text-sm">
            <Row label="Total" value={rupees(b.grandTotal)} strong />
            <Row label="Paid" value={rupees(b.amountPaid)} />
            {b.status === 'posted' && <Row label="To pay" value={rupees(b.balanceDue)} />}
          </dl>
        </Card>
      </div>
      <LinesCard lines={b.lines} totals={b} interState={b.supplierStateCode !== b.buyerStateCode} />
      {dialog === 'pay' && (
        <PaySupplierModal
          supplier={{ id: b.supplierId, name: b.supplierName }}
          initialAmount={b.balanceDue}
          initialAllocations={{ [b.id]: b.balanceDue }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'cancel' && (
        <ReasonDialog
          title="Cancel this purchase?"
          description="The goods are taken out of stock again and the supplier's balance is reversed. Not possible if they were already sold."
          confirmLabel="Cancel purchase"
          onClose={() => setDialog(null)}
          onConfirm={(reason) =>
            actions.run(
              'cancel',
              () => api(`/v1/purchase-bills/${id}/cancel`, { method: 'POST', body: { reason } }),
              'Purchase cancelled',
            )
          }
        />
      )}
    </>
  );
}
