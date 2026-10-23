import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

const CONTROL =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-brand-600 disabled:bg-slate-50 disabled:text-slate-500';
const INVALID = 'ring-red-400 focus:ring-red-500';

interface FieldShellProps {
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** Label + control + hint/error, wired for screen readers. */
function FieldShell({ label, hint, error, className = '', children }: FieldShellProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-700">
          {label}
        </label>
      )}
      {children(id, describedBy)}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type Common = { label?: string; hint?: string; error?: string; wrapperClassName?: string };

export function Input({
  label,
  hint,
  error,
  wrapperClassName,
  className = '',
  ...rest
}: Common & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={wrapperClassName}>
      {(id, describedBy) => (
        <input
          id={id}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`${CONTROL} ${error ? INVALID : ''} ${className}`}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

export function Select({
  label,
  hint,
  error,
  wrapperClassName,
  className = '',
  children,
  ...rest
}: Common & SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={wrapperClassName}>
      {(id, describedBy) => (
        <select
          id={id}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`${CONTROL} pr-8 ${error ? INVALID : ''} ${className}`}
          {...rest}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
}

export function Textarea({
  label,
  hint,
  error,
  wrapperClassName,
  className = '',
  ...rest
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <FieldShell label={label} hint={hint} error={error} className={wrapperClassName}>
      {(id, describedBy) => (
        <textarea
          id={id}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`${CONTROL} ${error ? INVALID : ''} ${className}`}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

export function Checkbox({
  label,
  ...rest
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="inline-flex items-center gap-2 text-sm text-slate-700">
      <input
        type="checkbox"
        className="size-4 rounded border-slate-300 text-brand-700 focus:ring-brand-600"
        {...rest}
      />
      {label}
    </label>
  );
}
