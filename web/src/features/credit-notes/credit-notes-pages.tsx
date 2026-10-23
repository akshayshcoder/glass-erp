import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Ban, CheckCircle2, Printer, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { CreditNote, Page } from '../../api/types';
import { useCan } from '../../app/auth';
import {
  Badge,
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
import { formatDate, rupees } from '../../lib/format';
import { docCustomerLabel } from '../../lib/party-type';
import { openPdf } from '../../lib/pdf';
import { ReasonDialog, useDocumentActions } from '../documents/actions';
import { LinesCard, PartyCard } from '../documents/document-view';

/*
 * Credit notes: list and detail. New credit notes start from an invoice
 * ("Return / credit note" on the invoice page).
 */

const REASON_LABEL: Record<CreditNote['reason'], string> = {
  sales_return: 'Goods returned',
  rate_difference: 'Rate difference',
  discount: 'Discount',
  deficiency: 'Deficiency',
  other: 'Other',
};

export function CreditNotesPage() {
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['credit-notes', status],
    queryFn: () =>
      api<Page<CreditNote>>(`/v1/credit-notes?pageSize=100${status ? `&status=${status}` : ''}`),
  });

  return (
    <>
      <PageHeader
        title="Credit notes"
        subtitle="Returns and corrections. To create one, open the invoice and choose “Return / credit note”."
      />
      <Card>
        <div className="border-b border-slate-200 p-4">
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-40"
          >
            <option value="">All</option>
            <option value="posted">Posted</option>
            <option value="draft">Drafts</option>
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
        ) : !data?.items.length ? (
          <EmptyState title="No credit notes" />
        ) : (
          <Table
            head={
              <>
                <Th>Number</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Against</Th>
                <Th>Reason</Th>
                <Th right>Amount</Th>
                <Th>Status</Th>
              </>
            }
          >
            {data.items.map((n) => (
              <tr
                key={n.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => navigate(`/credit-notes/${n.id}`)}
              >
                <Td className="font-medium text-slate-900">{n.noteNo ?? 'Draft'}</Td>
                <Td>{formatDate(n.noteDate)}</Td>
                <Td>{docCustomerLabel(n.customerName, n.customerType)}</Td>
                <Td>{n.invoiceNo}</Td>
                <Td>
                  {REASON_LABEL[n.reason]} {n.restock && <Badge tone="blue">Restocked</Badge>}
                </Td>
                <Td right>{rupees(n.grandTotal)}</Td>
                <Td>
                  <StatusBadge status={n.status} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

export function CreditNotePage() {
  const { id } = useParams() as { id: string };
  const navigate = useNavigate();
  const canManage = useCan('creditNotes');
  const actions = useDocumentActions();
  const [cancelling, setCancelling] = useState(false);
  const { data: n, error } = useQuery({
    queryKey: ['credit-note', id],
    queryFn: () => api<CreditNote>(`/v1/credit-notes/${id}`),
  });

  if (error) return <ErrorBanner message={errorMessage(error)} />;
  if (!n) return <Spinner />;

  return (
    <>
      <Link
        to="/credit-notes"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> Credit notes
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {n.noteNo ?? 'Draft credit note'} <StatusBadge status={n.status} />
          </span>
        }
        subtitle={`${formatDate(n.noteDate)} · ${REASON_LABEL[n.reason]}${n.restock ? ' · goods back in stock' : ''}`}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Printer className="size-4" />}
              onClick={() =>
                openPdf(`/v1/credit-notes/${id}/pdf`).catch((e) =>
                  actions.setError(errorMessage(e)),
                )
              }
            >
              Print
            </Button>
            {n.status === 'draft' && canManage && (
              <>
                <Button
                  variant="secondary"
                  icon={<Trash2 className="size-4" />}
                  loading={actions.busy === 'delete'}
                  onClick={async () => {
                    if (
                      await actions.run(
                        'delete',
                        () => api(`/v1/credit-notes/${id}`, { method: 'DELETE' }),
                        'Draft deleted',
                      )
                    )
                      navigate('/credit-notes');
                  }}
                >
                  Delete draft
                </Button>
                <Button
                  icon={<CheckCircle2 className="size-4" />}
                  loading={actions.busy === 'post'}
                  onClick={() =>
                    actions.run(
                      'post',
                      () => api(`/v1/credit-notes/${id}/post`, { method: 'POST' }),
                      'Credit note posted',
                    )
                  }
                >
                  Post
                </Button>
              </>
            )}
            {n.status === 'posted' && canManage && (
              <Button
                variant="danger"
                icon={<Ban className="size-4" />}
                onClick={() => setCancelling(true)}
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
      {n.status === 'cancelled' && (
        <div className="mb-4">
          <ErrorBanner message={`Cancelled: ${n.cancelReason ?? ''}`} />
        </div>
      )}
      <div className="grid gap-6 sm:grid-cols-2">
        <PartyCard
          heading="Customer"
          name={
            n.partyId ? (
              <Link to={`/parties/${n.partyId}`} className="hover:underline">
                {docCustomerLabel(n.customerName, n.customerType)}
              </Link>
            ) : (
              docCustomerLabel(n.customerName, n.customerType)
            )
          }
          lines={[n.customerGstin ? `GSTIN ${n.customerGstin}` : null, n.remarks]}
        />
        <PartyCard
          heading="Against invoice"
          name={
            <Link to={`/invoices/${n.invoiceId}`} className="text-brand-700 hover:underline">
              {n.invoiceNo}
            </Link>
          }
          lines={[]}
        />
      </div>
      <LinesCard lines={n.lines} totals={n} interState={n.placeOfSupply !== n.sellerStateCode} />
      {cancelling && (
        <ReasonDialog
          title="Cancel this credit note?"
          description="The customer's balance goes back up and returned goods leave stock again."
          confirmLabel="Cancel credit note"
          onClose={() => setCancelling(false)}
          onConfirm={(reason) =>
            actions.run(
              'cancel',
              () => api(`/v1/credit-notes/${id}/cancel`, { method: 'POST', body: { reason } }),
              'Credit note cancelled',
            )
          }
        />
      )}
    </>
  );
}
