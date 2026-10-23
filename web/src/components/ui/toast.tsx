import { CheckCircle2, XCircle } from 'lucide-react';
import { type ReactNode, createContext, useCallback, useContext, useState } from 'react';

type Tone = 'success' | 'error';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

/** Short confirmation messages ("Invoice saved"), bottom-right, auto-dismissed. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, tone, message }]); // at most 3 on screen
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      tone === 'error' ? 6000 : 3500,
    );
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-center gap-2 rounded-md bg-slate-900 px-4 py-3 text-sm text-white shadow-lg"
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="size-4 text-emerald-400" aria-hidden />
            ) : (
              <XCircle className="size-4 text-red-400" aria-hidden />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
