import { useQuery } from '@tanstack/react-query';
import { Download, FileJson, Info } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { useCurrentBranch } from '../../app/shop-data';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { downloadFile } from '../../lib/download';
import { formatMoney, formatQty, todayIso } from '../../lib/format';
import { type ReportData, ReportTable } from './report-table';

/*
 * Reports for the owner and the GST accountant. Numbers come straight from the
 * API; the web app only formats them.
 */

const monthLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};
const firstOfMonth = () => `${todayIso().slice(0, 7)}-01`;
const previousMonth = () => {
  const [y, m] = todayIso().split('-').map(Number);
  const d = new Date(y!, m! - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

function useReport(path: string, enabled = true) {
  return useQuery({
    queryKey: ['report', path],
    queryFn: () => api<ReportData>(path),
    enabled,
  });
}

// ---- GSTR-1 -------------------------------------------------------------------------

interface TaxTotals {
  count?: number;
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
}
interface HsnRow extends TaxTotals {
  hsn: string;
  description: string;
  uqc: string;
  qty: string;
  rate: string;
  value: string;
}
interface Gstr1Summary {
  gstin: string;
  branchName: string;
  b2b: unknown[];
  b2cl: unknown[];
  b2cs: unknown[];
  cdnr: unknown[];
  cdnur: unknown[];
  hsn: { b2b: HsnRow[]; b2c: HsnRow[] };
  docs: { kind: string; from: string; to: string; total: number; cancelled: number }[];
  totals: Record<string, TaxTotals>;
}

const SECTIONS: [string, string][] = [
  ['b2b', 'B2B: registered customers'],
  ['b2cl', 'B2C large: inter-state, above ₹1 lakh'],
  ['b2cs', 'B2C small'],
  ['b2cs_credit', 'Credit notes on B2C small (netted)'],
  ['cdnr', 'Credit notes: registered'],
  ['cdnur', 'Credit notes: unregistered (B2CL)'],
];

export function GstReportPage() {
  const { branch } = useCurrentBranch();
  const [period, setPeriod] = useState(previousMonth());
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const base = branch ? `/v1/reports/gstr1?branchId=${branch.id}&period=${period}` : '';
  const { data, isLoading, error } = useQuery({
    queryKey: ['report', base],
    queryFn: () => api<Gstr1Summary>(base),
    enabled: !!branch && !!period,
  });

  async function download(format: 'xlsx' | 'portal') {
    setDownloading(format);
    setDownloadError(null);
    try {
      await downloadFile(`${base}&format=${format}`);
    } catch (err) {
      setDownloadError(errorMessage(err));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <>
      <PageHeader
        title="GSTR-1"
        subtitle={`${branch?.name ?? ''}${data ? ` · GSTIN ${data.gstin}` : ''}`}
        actions={
          <>
            <Input
              type="month"
              aria-label="Return period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-44"
            />
            <Button
              variant="secondary"
              icon={<Download className="size-4" />}
              loading={downloading === 'xlsx'}
              disabled={!data}
              onClick={() => void download('xlsx')}
            >
              Excel
            </Button>
            <Button
              icon={<FileJson className="size-4" />}
              loading={downloading === 'portal'}
              disabled={!data}
              onClick={() => void download('portal')}
            >
              JSON for GST portal
            </Button>
          </>
        }
      />
      <div className="mb-6 flex gap-2 rounded-md bg-sky-50 px-4 py-3 text-sm text-sky-800 ring-1 ring-sky-200">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          Give the Excel or JSON to your GST practitioner. They should open it in the GST offline
          tool and review it before uploading. After filing, lock the month in{' '}
          <strong>Settings → GST month lock</strong>.
        </p>
      </div>
      {(error || downloadError) && (
        <div className="mb-4">
          <ErrorBanner message={downloadError ?? errorMessage(error)} />
        </div>
      )}
      {isLoading ? (
        <Spinner />
      ) : data ? (
        <div className="space-y-6">
          <Card>
            <h2 className="px-4 py-3 text-sm font-semibold text-slate-900">
              Summary · {monthLabel(period)}
            </h2>
            <Table
              head={
                <>
                  <Th>Section</Th>
                  <Th right>Documents</Th>
                  <Th right>Taxable</Th>
                  <Th right>IGST</Th>
                  <Th right>CGST</Th>
                  <Th right>SGST</Th>
                </>
              }
            >
              {SECTIONS.filter(([key]) => data.totals[key]).map(([key, label]) => {
                const t = data.totals[key]!;
                return (
                  <tr key={key}>
                    <Td className="text-slate-900">{label}</Td>
                    <Td right>{t.count}</Td>
                    <Td right>{formatMoney(t.taxable)}</Td>
                    <Td right>{formatMoney(t.igst)}</Td>
                    <Td right>{formatMoney(t.cgst)}</Td>
                    <Td right>{formatMoney(t.sgst)}</Td>
                  </tr>
                );
              })}
            </Table>
            {Object.keys(data.totals).length === 0 && (
              <EmptyState title={`No sales in ${monthLabel(period)}`} />
            )}
          </Card>

          {(['b2b', 'b2c'] as const).map((kind) =>
            data.hsn[kind].length ? (
              <Card key={kind}>
                <h2 className="px-4 py-3 text-sm font-semibold text-slate-900">
                  HSN summary · {kind.toUpperCase()}
                </h2>
                <Table
                  head={
                    <>
                      <Th>HSN</Th>
                      <Th>Description</Th>
                      <Th>UQC</Th>
                      <Th right>Qty</Th>
                      <Th right>Rate</Th>
                      <Th right>Taxable</Th>
                      <Th right>IGST</Th>
                      <Th right>CGST</Th>
                      <Th right>SGST</Th>
                    </>
                  }
                >
                  {data.hsn[kind].map((h) => (
                    <tr key={`${h.hsn}-${h.rate}`}>
                      <Td className="font-medium text-slate-900">{h.hsn}</Td>
                      <Td>{h.description}</Td>
                      <Td>{h.uqc}</Td>
                      <Td right>{formatQty(h.qty)}</Td>
                      <Td right>{Number(h.rate)}%</Td>
                      <Td right>{formatMoney(h.taxable)}</Td>
                      <Td right>{formatMoney(h.igst)}</Td>
                      <Td right>{formatMoney(h.cgst)}</Td>
                      <Td right>{formatMoney(h.sgst)}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            ) : null,
          )}

          {data.docs.length > 0 && (
            <Card>
              <h2 className="px-4 py-3 text-sm font-semibold text-slate-900">Documents issued</h2>
              <Table
                head={
                  <>
                    <Th>Document</Th>
                    <Th>From</Th>
                    <Th>To</Th>
                    <Th right>Total</Th>
                    <Th right>Cancelled</Th>
                  </>
                }
              >
                {data.docs.map((d) => (
                  <tr key={`${d.kind}-${d.from}`}>
                    <Td>{d.kind}</Td>
                    <Td>{d.from}</Td>
                    <Td>{d.to}</Td>
                    <Td right>{d.total}</Td>
                    <Td right>{d.cancelled}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          )}
        </div>
      ) : null}
    </>
  );
}

// ---- Tabular reports ------------------------------------------------------------------

function DateRange({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  return (
    <>
      <Input
        type="date"
        aria-label="From"
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        className="w-40"
      />
      <Input
        type="date"
        aria-label="To"
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
        className="w-40"
      />
    </>
  );
}

export function SalesReportPage() {
  const { branch } = useCurrentBranch();
  const [range, setRange] = useState({ from: firstOfMonth(), to: todayIso() });
  const [groupBy, setGroupBy] = useState('day');
  const path = `/v1/reports/sales?from=${range.from}&to=${range.to}&groupBy=${groupBy}${branch ? `&branchId=${branch.id}` : ''}`;
  const report = useReport(path, !!branch);
  return (
    <>
      <PageHeader
        title="Sales"
        subtitle={
          groupBy === 'product'
            ? 'Margin is estimated using each product’s last purchase price'
            : branch?.name
        }
        actions={
          <>
            <Select
              aria-label="Group by"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              className="w-40"
            >
              <option value="day">By day</option>
              <option value="month">By month</option>
              <option value="product">By product</option>
              <option value="customer">By customer</option>
            </Select>
            <DateRange
              from={range.from}
              to={range.to}
              onChange={(from, to) => setRange({ from, to })}
            />
          </>
        }
      />
      <ReportTable
        data={report.data}
        loading={report.isLoading}
        error={report.error}
        exportPath={`${path}&format=xlsx`}
      />
    </>
  );
}

export function DuesReportPage() {
  const { branch } = useCurrentBranch();
  const [side, setSide] = useState<'receivables' | 'payables'>('receivables');
  const path = `/v1/reports/${side}${branch ? `?branchId=${branch.id}` : ''}`;
  const report = useReport(path, !!branch);
  return (
    <>
      <PageHeader
        title="Dues"
        subtitle="Unpaid bills by how old they are"
        actions={
          <Select
            aria-label="Show"
            value={side}
            onChange={(e) => setSide(e.target.value as typeof side)}
            className="w-52"
          >
            <option value="receivables">Customers owe us</option>
            <option value="payables">We owe suppliers</option>
          </Select>
        }
      />
      <ReportTable
        data={report.data}
        loading={report.isLoading}
        error={report.error}
        exportPath={`${path}${path.includes('?') ? '&' : '?'}format=xlsx`}
        emptyText="Nothing outstanding"
      />
    </>
  );
}

export function StockValueReportPage() {
  const { branch } = useCurrentBranch();
  const path = `/v1/reports/stock-value${branch ? `?branchId=${branch.id}` : ''}`;
  const report = useReport(path, !!branch);
  return (
    <>
      <PageHeader title="Stock value" subtitle="Quantity in stock × last purchase price" />
      <ReportTable
        data={report.data}
        loading={report.isLoading}
        error={report.error}
        exportPath={`${path}${path.includes('?') ? '&' : '?'}format=xlsx`}
        emptyText="No stock"
      />
    </>
  );
}

export function PurchaseRegisterPage() {
  const { branch } = useCurrentBranch();
  const [range, setRange] = useState({ from: `${previousMonth()}-01`, to: todayIso() });
  const path = `/v1/reports/purchases?from=${range.from}&to=${range.to}${branch ? `&branchId=${branch.id}` : ''}`;
  const report = useReport(path, !!branch);
  return (
    <>
      <PageHeader
        title="Purchase register"
        subtitle="Supplier bills with GST, to match input tax credit with GSTR-2B"
        actions={
          <DateRange
            from={range.from}
            to={range.to}
            onChange={(from, to) => setRange({ from, to })}
          />
        }
      />
      <ReportTable
        data={report.data}
        loading={report.isLoading}
        error={report.error}
        exportPath={`${path}&format=xlsx`}
      />
    </>
  );
}
