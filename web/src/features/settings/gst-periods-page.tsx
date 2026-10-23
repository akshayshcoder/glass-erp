import { useQuery } from '@tanstack/react-query';
import { Lock, Unlock } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import type { GstLock } from '../../api/types';
import { useCan } from '../../app/auth';
import { useCurrentBranch } from '../../app/shop-data';
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
} from '../../components/ui';
import { formatDate, todayIso } from '../../lib/format';
import { ReasonDialog, useDocumentActions } from '../documents/actions';

const monthLabel = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return new Date(y!, m! - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
};

/** Previous month as YYYY-MM: the month usually filed next. */
function lastMonth(): string {
  const [y, m] = todayIso().split('-').map(Number);
  const d = new Date(y!, m! - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/*
 * After the GST return for a month is filed, lock it: nothing dated in that
 * month can be posted or cancelled any more (corrections need a credit note).
 */
export function GstPeriodsPage() {
  const { branch } = useCurrentBranch();
  const canLock = useCan('lockGstPeriod');
  const canUnlock = useCan('unlockGstPeriod');
  const actions = useDocumentActions();
  const [period, setPeriod] = useState(lastMonth());
  const [note, setNote] = useState('');
  const [unlocking, setUnlocking] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['gst-periods', branch?.id],
    queryFn: () =>
      api<{ items: GstLock[] }>(`/v1/gst-periods?branchId=${branch!.id}`).then((r) => r.items),
    enabled: !!branch,
  });

  async function lock() {
    if (!branch) return;
    const ok = await actions.run(
      'lock',
      () =>
        api('/v1/gst-periods/lock', {
          method: 'POST',
          body: { branchId: branch.id, period, ...(note.trim() && { note: note.trim() }) },
        }),
      `${monthLabel(period)} locked`,
    );
    if (ok) setNote('');
  }

  return (
    <>
      <PageHeader
        title="GST month lock"
        subtitle={`Lock a month after its return is filed · ${branch?.name ?? ''}`}
      />
      {actions.error && (
        <div className="mb-4">
          <ErrorBanner message={actions.error} />
        </div>
      )}
      {canLock && (
        <Card className="mb-6 p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">Lock a filed month</h2>
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label="Month"
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              className="w-44"
            />
            <Input
              label="Note"
              placeholder="e.g. GSTR-1 filed on 11th"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              wrapperClassName="min-w-60 flex-1"
            />
            <Button
              icon={<Lock className="size-4" />}
              loading={actions.busy === 'lock'}
              onClick={() => void lock()}
            >
              Lock {period && monthLabel(period)}
            </Button>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Bills, purchases and credit notes dated in a locked month can no longer be posted or
            cancelled. Corrections go through a credit note in an open month.
          </p>
        </Card>
      )}
      <Card>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading ? (
          <Spinner />
        ) : !data?.length ? (
          <EmptyState title="No months locked yet" />
        ) : (
          <Table
            head={
              <>
                <Th>Month</Th>
                <Th>Locked on</Th>
                <Th>By</Th>
                <Th>Note</Th>
                <Th />
              </>
            }
          >
            {data.map((l) => (
              <tr key={l.period}>
                <Td className="font-medium text-slate-900">{monthLabel(l.period)}</Td>
                <Td>{formatDate(l.lockedAt)}</Td>
                <Td>{l.lockedByName}</Td>
                <Td>{l.note}</Td>
                <Td>
                  {canUnlock && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Unlock className="size-3.5" />}
                      onClick={() => setUnlocking(l.period)}
                    >
                      Unlock
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {unlocking && branch && (
        <ReasonDialog
          title={`Unlock ${monthLabel(unlocking)}?`}
          description="Only do this if the month was locked by mistake. The reason is recorded in the audit log."
          confirmLabel="Unlock"
          onClose={() => setUnlocking(null)}
          onConfirm={(reason) =>
            actions.run(
              'unlock',
              () =>
                api('/v1/gst-periods/unlock', {
                  method: 'POST',
                  body: { branchId: branch.id, period: unlocking, reason },
                }),
              `${monthLabel(unlocking)} unlocked`,
            )
          }
        />
      )}
    </>
  );
}
