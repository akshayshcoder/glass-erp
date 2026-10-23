import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { Button, Input, Modal, useToast } from '../../components/ui';

/*
 * Helpers for the action buttons on document pages (post, cancel, delete, print…):
 * one busy flag, one error banner, and a refresh of every list the action affects.
 */

/** Query keys refreshed after any document action. */
const AFFECTED = [
  'invoices',
  'invoice',
  'receipts',
  'credit-notes',
  'credit-note',
  'quotations',
  'quotation',
  'purchase-bills',
  'purchase-bill',
  'supplier-payments',
  'dashboard',
  'stock',
  'parties',
  'party',
  'gst-periods',
  'members',
  'branches',
];

export function useDocumentActions() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(name: string, action: () => Promise<unknown>, done?: string) {
    setBusy(name);
    setError(null);
    try {
      await action();
      await Promise.all(AFFECTED.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      if (done) toast(done);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, run, setError };
}

/** "Why?" dialog for cancellations and other actions that need a reason. */
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<boolean>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Go back
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!reason.trim()}
            onClick={async () => {
              setBusy(true);
              const ok = await onConfirm(reason.trim());
              setBusy(false);
              if (ok) onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-600">{description}</p>
      <Input
        label="Reason"
        required
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </Modal>
  );
}
