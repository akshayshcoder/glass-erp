import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, FilePlus2, IndianRupee } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { Dashboard } from '../../api/types';
import { useCan } from '../../app/auth';
import { useCurrentBranch } from '../../app/shop-data';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  PageHeader,
  Spinner,
  StatusBadge,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { formatDate, rupees } from '../../lib/format';
import { docCustomerLabel } from '../../lib/party-type';

export function DashboardPage() {
  const { branch } = useCurrentBranch();
  const canSell = useCan('sell');
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', branch?.id],
    queryFn: () => api<Dashboard>(`/v1/dashboard${branch ? `?branchId=${branch.id}` : ''}`),
    enabled: !!branch,
  });

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={branch?.name}
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
      {error && <ErrorBanner message={errorMessage(error)} />}
      {isLoading || !data ? (
        !error && <Spinner />
      ) : (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              icon={<IndianRupee className="size-5" />}
              label="Sales today"
              value={rupees(data.today.sales)}
              note={plural(data.today.invoices, 'bill')}
            />
            <Stat
              icon={<IndianRupee className="size-5" />}
              label="Sales this month"
              value={rupees(data.month.sales)}
              note={plural(data.month.invoices, 'bill')}
            />
            <Stat
              icon={<ArrowDownLeft className="size-5" />}
              label="To collect"
              value={rupees(data.receivable)}
              note="Unpaid customer bills"
            />
            <Stat
              icon={<ArrowUpRight className="size-5" />}
              label="To pay"
              value={rupees(data.payable)}
              note={
                data.lowStockItems > 0 ? (
                  <Link
                    to="/stock?low=1"
                    className="inline-flex items-center gap-1 text-amber-700 hover:underline"
                  >
                    <AlertTriangle className="size-3.5" /> {data.lowStockItems} items low on stock
                  </Link>
                ) : (
                  'Unpaid supplier bills'
                )
              }
            />
          </div>

          <Card>
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">Recent bills</h2>
              <Link to="/invoices" className="text-sm font-medium text-brand-700 hover:underline">
                View all
              </Link>
            </div>
            {data.recentInvoices.length === 0 ? (
              <EmptyState title="No bills yet">Create your first bill with “New bill”.</EmptyState>
            ) : (
              <Table
                head={
                  <>
                    <Th>Bill</Th>
                    <Th>Date</Th>
                    <Th>Customer</Th>
                    <Th right>Amount</Th>
                    <Th right>Due</Th>
                    <Th>Status</Th>
                  </>
                }
              >
                {data.recentInvoices.map((i) => (
                  <tr
                    key={i.id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => navigate(`/invoices/${i.id}`)}
                  >
                    <Td className="font-medium text-slate-900">{i.invoiceNo ?? 'Draft'}</Td>
                    <Td>{formatDate(i.invoiceDate)}</Td>
                    <Td>{docCustomerLabel(i.customerName, i.customerType)}</Td>
                    <Td right>{rupees(i.grandTotal)}</Td>
                    <Td right>{i.status === 'posted' ? rupees(i.balanceDue) : ''}</Td>
                    <Td>
                      <StatusBadge status={i.status} />
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  note,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  note: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <span className="text-brand-700">{icon}</span>
        {label}
      </div>
      <p className="num mt-2 text-2xl font-semibold text-slate-900">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{note}</p>
    </Card>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
