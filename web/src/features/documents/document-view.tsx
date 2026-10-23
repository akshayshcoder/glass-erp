import type { ReactNode } from 'react';
import type { InvoiceLine, InvoiceTotals } from '../../api/types';
import { Card, Table, Td, Th } from '../../components/ui';
import { formatMoney, formatQty, rupees } from '../../lib/format';

/*
 * Read-only pieces shared by every document detail page (invoice, quotation,
 * purchase bill, credit note), so they all look the same.
 */

/** The line items and the GST totals underneath. */
export function LinesCard({
  lines,
  totals,
  interState,
}: {
  lines: InvoiceLine[];
  totals: InvoiceTotals;
  interState: boolean;
}) {
  return (
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
        {lines.map((l) => (
          <tr key={l.lineNo}>
            <Td className="text-slate-400">{l.lineNo}</Td>
            <Td className="text-slate-900">{l.description}</Td>
            <Td>{l.hsnCode}</Td>
            <Td right>{Number(l.qty) ? `${formatQty(l.qty)} ${l.unitCode}` : '—'}</Td>
            <Td right>{Number(l.rate) ? formatMoney(l.rate) : '—'}</Td>
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
          <TotalsRows totals={totals} interState={interState} />
        </dl>
      </div>
    </Card>
  );
}

/** Taxable, CGST+SGST or IGST, round off, total, as <dt>/<dd> rows. */
export function TotalsRows({
  totals,
  interState,
}: {
  totals: Partial<InvoiceTotals> | undefined;
  interState: boolean;
}) {
  const v = (x: string | undefined) => formatMoney(x ?? '0.00');
  return (
    <>
      <Row label="Taxable value" value={v(totals?.taxableValue)} />
      {interState ? (
        <Row label="IGST" value={v(totals?.igstAmount)} />
      ) : (
        <>
          <Row label="CGST" value={v(totals?.cgstAmount)} />
          <Row label="SGST" value={v(totals?.sgstAmount)} />
        </>
      )}
      <Row label="Round off" value={v(totals?.roundOff)} />
      <div className="flex justify-between border-t border-slate-200 pt-1.5 text-base font-semibold text-slate-900">
        <dt>Total</dt>
        <dd>{rupees(totals?.grandTotal ?? '0.00')}</dd>
      </div>
    </>
  );
}

export function Row({
  label,
  value,
  strong,
}: {
  label: string;
  value: ReactNode;
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

/** "Bill to" / "Supplier" card. */
export function PartyCard({
  heading,
  name,
  lines,
}: {
  heading: string;
  name: ReactNode;
  lines: (string | null | undefined)[];
}) {
  return (
    <Card className="p-5">
      <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{heading}</p>
      <p className="mt-1 font-medium text-slate-900">{name}</p>
      <p className="text-sm text-slate-500">{lines.filter(Boolean).join(' · ')}</p>
    </Card>
  );
}
