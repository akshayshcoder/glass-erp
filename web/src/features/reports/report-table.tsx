import { Download } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { Button, Card, EmptyState, ErrorBanner, Spinner } from '../../components/ui';
import { downloadFile } from '../../lib/download';
import { formatDate, formatMoney, formatQty } from '../../lib/format';

/*
 * Shows any tabular report from the API: { title, columns, rows, totals }.
 * The API decides the columns, so a new report needs no new table code.
 */

export interface ReportColumn {
  key: string;
  header: string;
  type?: 'text' | 'money' | 'qty' | 'int' | 'rate';
}

export interface ReportData {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, string>;
}

const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

function cell(value: unknown, type: ReportColumn['type']): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  switch (type) {
    case 'money':
      return formatMoney(s);
    case 'qty':
      return formatQty(s);
    case 'rate':
      return formatQty(s);
    default:
      return isDate(s) ? formatDate(s) : s;
  }
}

const numeric = (type: ReportColumn['type']) => type && type !== 'text';

export function ReportTable({
  data,
  loading,
  error,
  exportPath,
  emptyText = 'Nothing to show for this selection',
}: {
  data: ReportData | undefined;
  loading: boolean;
  error: unknown;
  /** API path that returns the same report as Excel. */
  exportPath: string;
  emptyText?: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadFile(exportPath);
    } catch (err) {
      setDownloadError(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{data?.title ?? ''}</h2>
        <Button
          size="sm"
          variant="secondary"
          icon={<Download className="size-4" />}
          loading={downloading}
          disabled={!data?.rows.length}
          onClick={() => void download()}
        >
          Download Excel
        </Button>
      </div>
      {(error || downloadError) && (
        <div className="p-4">
          <ErrorBanner message={downloadError ?? errorMessage(error)} />
        </div>
      )}
      {loading ? (
        <Spinner />
      ) : !data?.rows.length ? (
        <EmptyState title={emptyText} />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
              <tr>
                {data.columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={`px-4 py-3 ${numeric(c.type) ? 'text-right' : 'text-left'}`}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {data.rows.map((row, i) => (
                <tr key={i}>
                  {data.columns.map((c) => (
                    <td
                      key={c.key}
                      className={`px-4 py-2.5 ${numeric(c.type) ? 'num text-right' : ''}`}
                    >
                      {cell(row[c.key], c.type)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {Object.keys(data.totals).length > 0 && (
              <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold text-slate-900">
                <tr>
                  {data.columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={`px-4 py-3 ${numeric(c.type) ? 'num text-right' : ''}`}
                    >
                      {i === 0
                        ? 'Total'
                        : c.key in data.totals
                          ? cell(data.totals[c.key], c.type)
                          : ''}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Card>
  );
}
