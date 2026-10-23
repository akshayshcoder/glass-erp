import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  Check,
  FilePlus2,
  FileText,
  Pencil,
  Printer,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { Invoice, Page, Quotation } from '../../api/types';
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
import { openPdf } from '../../lib/pdf';
import { ReasonDialog, useDocumentActions } from '../documents/actions';
import { LinesCard, PartyCard } from '../documents/document-view';

/*
 * Quotations: draft -> issue (gets a number, frozen) -> accept / reject ->
 * convert into a draft bill.
 */

export function QuotationsPage() {
  const navigate = useNavigate();
  const canQuote = useCan('quote');
  const [status, setStatus] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['quotations', status],
    queryFn: () =>
      api<Page<Quotation>>(`/v1/quotations?pageSize=100${status ? `&status=${status}` : ''}`),
  });

  return (
    <>
      <PageHeader
        title="Quotations"
        subtitle="Estimates for customers and contractors"
        actions={
          canQuote && (
            <Button
              icon={<FilePlus2 className="size-4" />}
              onClick={() => navigate('/quotations/new')}
            >
              New quotation
            </Button>
          )
        }
      />
      <Card>
        <div className="border-b border-slate-200 p-4">
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-44"
          >
            <option value="">All</option>
            <option value="draft">Drafts</option>
            <option value="issued">Issued</option>
            <option value="accepted">Accepted</option>
            <option value="converted">Converted to bill</option>
            <option value="rejected">Rejected</option>
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
          <EmptyState title="No quotations" />
        ) : (
          <Table
            head={
              <>
                <Th>Number</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Valid until</Th>
                <Th right>Amount</Th>
                <Th>Status</Th>
              </>
            }
          >
            {data.items.map((q) => (
              <tr
                key={q.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => navigate(`/quotations/${q.id}`)}
              >
                <Td className="font-medium text-slate-900">{q.quoteNo ?? 'Draft'}</Td>
                <Td>{formatDate(q.quoteDate)}</Td>
                <Td>{q.customerName}</Td>
                <Td>{formatDate(q.validUntil)}</Td>
                <Td right>{rupees(q.grandTotal)}</Td>
                <Td>
                  <StatusBadge status={q.status} />
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

export function QuotationPage() {
  const { id } = useParams() as { id: string };
  const navigate = useNavigate();
  const canQuote = useCan('quote');
  const actions = useDocumentActions();
  const [cancelling, setCancelling] = useState(false);
  const { data: q, error } = useQuery({
    queryKey: ['quotation', id],
    queryFn: () => api<Quotation>(`/v1/quotations/${id}`),
  });

  if (error) return <ErrorBanner message={errorMessage(error)} />;
  if (!q) return <Spinner />;

  const act = (path: string, done: string) =>
    actions.run(path, () => api(`/v1/quotations/${id}/${path}`, { method: 'POST' }), done);

  async function convert() {
    const created: { invoice?: Invoice } = {};
    const ok = await actions.run(
      'convert',
      async () => {
        created.invoice = await api<Invoice>(`/v1/quotations/${id}/convert`, { method: 'POST' });
      },
      'Draft bill created from the quotation',
    );
    if (ok && created.invoice) navigate(`/invoices/${created.invoice.id}`);
  }

  const open = q.status === 'issued' || q.status === 'accepted';
  return (
    <>
      <Link
        to="/quotations"
        className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
      >
        <ArrowLeft className="size-4" /> Quotations
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {q.quoteNo ?? 'Draft quotation'} <StatusBadge status={q.status} />
            {q.isExpired && <Badge tone="amber">Expired</Badge>}
          </span>
        }
        subtitle={`${formatDate(q.quoteDate)}${q.validUntil ? ` · valid until ${formatDate(q.validUntil)}` : ''}`}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Printer className="size-4" />}
              onClick={() =>
                openPdf(`/v1/quotations/${id}/pdf`).catch((e) => actions.setError(errorMessage(e)))
              }
            >
              Print
            </Button>
            {canQuote && q.status === 'draft' && (
              <>
                <Button
                  variant="secondary"
                  icon={<Trash2 className="size-4" />}
                  loading={actions.busy === 'delete'}
                  onClick={async () => {
                    if (
                      await actions.run(
                        'delete',
                        () => api(`/v1/quotations/${id}`, { method: 'DELETE' }),
                        'Draft deleted',
                      )
                    )
                      navigate('/quotations');
                  }}
                >
                  Delete
                </Button>
                <Button
                  variant="secondary"
                  icon={<Pencil className="size-4" />}
                  onClick={() => navigate(`/quotations/${id}/edit`)}
                >
                  Edit
                </Button>
                <Button
                  icon={<Send className="size-4" />}
                  loading={actions.busy === 'issue'}
                  onClick={() => act('issue', 'Quotation issued')}
                >
                  Issue
                </Button>
              </>
            )}
            {canQuote && q.status === 'issued' && (
              <>
                <Button
                  variant="secondary"
                  icon={<X className="size-4" />}
                  loading={actions.busy === 'reject'}
                  onClick={() => act('reject', 'Marked as rejected')}
                >
                  Rejected
                </Button>
                <Button
                  variant="secondary"
                  icon={<Check className="size-4" />}
                  loading={actions.busy === 'accept'}
                  onClick={() => act('accept', 'Marked as accepted')}
                >
                  Accepted
                </Button>
              </>
            )}
            {canQuote && open && (
              <Button
                icon={<FileText className="size-4" />}
                loading={actions.busy === 'convert'}
                onClick={() => void convert()}
              >
                Convert to bill
              </Button>
            )}
            {canQuote && q.status === 'converted' && q.invoiceId && (
              <Button
                variant="secondary"
                icon={<FileText className="size-4" />}
                onClick={() => navigate(`/invoices/${q.invoiceId}`)}
              >
                Open bill
              </Button>
            )}
            {canQuote && (open || q.status === 'rejected') && (
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
      {q.status === 'cancelled' && (
        <div className="mb-4">
          <ErrorBanner message={`Cancelled: ${q.cancelReason ?? ''}`} />
        </div>
      )}
      <PartyCard
        heading="Customer"
        name={q.customerName}
        lines={[q.customerGstin ? `GSTIN ${q.customerGstin}` : null, q.customerPhone]}
      />
      <LinesCard lines={q.lines} totals={q} interState={q.placeOfSupply !== q.sellerStateCode} />
      {q.terms && (
        <Card className="mt-6 p-5 text-sm">
          <p className="mb-1 font-medium text-slate-900">Terms</p>
          <p className="whitespace-pre-line text-slate-600">{q.terms}</p>
        </Card>
      )}
      {cancelling && (
        <ReasonDialog
          title="Cancel this quotation?"
          description="It stays in the list as cancelled."
          confirmLabel="Cancel quotation"
          onClose={() => setCancelling(false)}
          onConfirm={(reason) =>
            actions.run(
              'cancel',
              () => api(`/v1/quotations/${id}/cancel`, { method: 'POST', body: { reason } }),
              'Quotation cancelled',
            )
          }
        />
      )}
    </>
  );
}
