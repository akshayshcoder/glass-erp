import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

/**
 * Dialog built on the native <dialog> element: focus trapping, Esc to close and
 * the backdrop come from the browser.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto w-[calc(100%-1.5rem)] sm:w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl sm:rounded-lg p-0 shadow-2xl backdrop:bg-slate-900/50 backdrop:backdrop-blur-xs`}
    >
      {open && (
        <div className="flex max-h-[90vh] sm:max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-5 sm:py-4">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus:outline-hidden"
              aria-label="Close"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-3 sm:px-5 sm:py-4">{children}</div>
          {footer && (
            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 sm:px-5">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
