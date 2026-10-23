import { useInfiniteQuery } from '@tanstack/react-query';
import { FilePlus2, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { InvoiceSummary, Page } from '../../api/types';
import { useCan } from '../../app/auth';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
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

export function InvoicesPage() {
  const navigate = useNavigate();
  const canSell = useCan('sell');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const q = useDebounced(search.trim(), 250);

  const filters = new URLSearchParams({
    pageSize: '50',
    ...(q && { search: q }),
    ...(status && { status }),
    ...(from && { from }),
    ...(to && { to }),
  });
  const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['invoices', filters.toString()],
      queryFn: ({ pageParam }) =>
        api<Page<InvoiceSummary>>(
          `/v1/sales-invoices?${filters}${pageParam ? `&pageToken=${pageParam}` : ''}`,
        ),
      initialPageParam: '',
      getNextPageParam: (last) => last.nextPageToken ?? undefined,
    });
  const invoices = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Invoices"
        actions={
          canSell && (
            <Button
              icon={<FilePlus2 className="size-4" />}
              onClick={() => navigate('/invoices/new')}
            >
              New bill
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
              placeholder="Bill number or customer…"
              aria-label="Search invoices"
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
          <Input
            type="date"
            aria-label="From date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-40"
          />
          <Input
            type="date"
            aria-label="To date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-40"
          />
        </div>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading ? (
          <Spinner />
        ) : invoices.length === 0 ? (
          <EmptyState title="No invoices found" />
        ) : (
          <>
            <Table
              head={
                <>
                  <Th>Bill</Th>
                  <Th>Date</Th>
                  <Th>Customer</Th>
                  <Th right>Amount</Th>
                  <Th right>Balance due</Th>
                  <Th>Status</Th>
                </>
              }
            >
              {invoices.map((i) => (
                <tr
                  key={i.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/invoices/${i.id}`)}
                >
                  <Td className="font-medium text-slate-900">{i.invoiceNo ?? 'Draft'}</Td>
                  <Td>{formatDate(i.invoiceDate)}</Td>
                  <Td>
                    {i.customerName} {i.supplyType === 'b2b' && <Badge tone="blue">B2B</Badge>}
                  </Td>
                  <Td right>{rupees(i.grandTotal)}</Td>
                  <Td
                    right
                    className={
                      i.status === 'posted' && !isZero(i.balanceDue)
                        ? 'font-medium text-amber-700'
                        : 'text-slate-400'
                    }
                  >
                    {i.status === 'posted' ? rupees(i.balanceDue) : ''}
                  </Td>
                  <Td>
                    <StatusBadge status={i.status} />
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
