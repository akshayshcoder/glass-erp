import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg bg-white shadow-xs ring-1 ring-slate-200 ${className}`}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-4 sm:mb-6 flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-slate-900 truncate">{title}</h1>
        {subtitle && <p className="mt-0.5 sm:mt-1 text-xs sm:text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500"
    >
      <Loader2 className="size-5 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      {children && <div className="mt-2 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200"
    >
      {message}
    </div>
  );
}

const BADGE_TONES = {
  gray: 'bg-slate-100 text-slate-700 ring-slate-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
};

export function Badge({
  tone = 'gray',
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'posted'
      ? 'green'
      : status === 'cancelled'
        ? 'red'
        : status === 'draft'
          ? 'amber'
          : 'blue';
  return <Badge tone={tone}>{status.charAt(0).toUpperCase() + status.slice(1)}</Badge>;
}

/** A simple data table: pass header cells and rows. Supports smooth mobile scrolling with touch indicators. */
export function Table({
  head,
  children,
  className = '',
}: {
  head: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`overflow-x-auto overscroll-x-contain -mx-px ${className}`}>
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-600 uppercase">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">{children}</tbody>
      </table>
    </div>
  );
}

export const Th = ({
  children,
  right,
  className = '',
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) => (
  <th
    scope="col"
    className={`px-3 py-2.5 sm:px-4 sm:py-3 whitespace-nowrap ${right ? 'text-right' : ''} ${className}`}
  >
    {children}
  </th>
);

export const Td = ({
  children,
  right,
  className = '',
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) => (
  <td className={`px-3 py-2.5 sm:px-4 sm:py-3 text-slate-600 ${right ? 'num text-right' : ''} ${className}`}>
    {children}
  </td>
);
