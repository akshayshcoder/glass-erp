import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import type { Page, Party, PartyKind } from '../../api/types';
import { useCan } from '../../app/auth';
import { useReference } from '../../app/shop-data';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
  useToast,
} from '../../components/ui';
import { isNegative, isZero, rupees } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';

export function PartiesPage() {
  const canEdit = useCan('manageParties');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [regFilter, setRegFilter] = useState<'all' | 'registered' | 'walkin'>('all');
  const [creating, setCreating] = useState(false);
  const q = useDebounced(search.trim(), 250);

  const params = new URLSearchParams({
    pageSize: '100',
    ...(q && { search: q }),
    ...(kind && { kind }),
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['parties', params.toString()],
    queryFn: () => api<Page<Party>>(`/v1/parties?${params}`),
    placeholderData: keepPreviousData,
  });

  const filteredItems = (data?.items ?? []).filter((p) => {
    if (regFilter === 'registered') return Boolean(p.gstin);
    if (regFilter === 'walkin') return !p.gstin;
    return true;
  });

  return (
    <>
      <PageHeader
        title="Customers & suppliers"
        subtitle="Balances are live: positive = they owe you, negative = you owe them"
        actions={
          canEdit && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New party
            </Button>
          )
        }
      />
      <Card>
        <div className="flex flex-wrap gap-3 border-b border-slate-200 p-4">
          <div className="relative min-w-60 flex-1">
            <Search
              className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400"
              aria-hidden
            />
            <input
              type="search"
              placeholder="Search name, phone or GSTIN…"
              aria-label="Search parties"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="block w-full rounded-md border-0 py-2 pr-3 pl-9 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
            />
          </div>
          <Select
            aria-label="Type"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="w-36"
          >
            <option value="">Everyone</option>
            <option value="customer">Customers</option>
            <option value="supplier">Suppliers</option>
          </Select>
          <Select
            aria-label="Customer Type"
            value={regFilter}
            onChange={(e) => setRegFilter(e.target.value as 'all' | 'registered' | 'walkin')}
            className="w-44"
          >
            <option value="all">All Registrations</option>
            <option value="registered">Registered B2B</option>
            <option value="walkin">Walk-in / Cash</option>
          </Select>
        </div>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading ? (
          <Spinner />
        ) : !filteredItems.length ? (
          <EmptyState title="No one matches your filters" />
        ) : (
          <Table
            head={
              <>
                <Th>Name &amp; Type</Th>
                <Th>Role</Th>
                <Th>Phone</Th>
                <Th>GSTIN</Th>
                <Th right>Wallet (Adv.)</Th>
                <Th right>Balance</Th>
              </>
            }
          >
            {filteredItems.map((p) => (
              <tr
                key={p.id}
                className="cursor-pointer hover:bg-slate-50"
                onClick={() => navigate(`/parties/${p.id}`)}
              >
                <Td className="font-medium text-slate-900">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span>{p.name}</span>
                    <span
                      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
                        p.gstin
                          ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-600/20'
                          : 'bg-slate-100 text-slate-600 ring-1 ring-slate-400/20'
                      }`}
                    >
                      {p.gstin ? 'Registered B2B' : 'Walk-in / Cash'}
                    </span>
                  </div>
                </Td>
                <Td>
                  <span className="capitalize">{p.kind}</span>
                </Td>
                <Td>{p.phone}</Td>
                <Td>{p.gstin ?? <Badge>Unregistered</Badge>}</Td>
                <Td right>
                  {p.walletBalance && Number(p.walletBalance) > 0 ? (
                    <span className="inline-flex items-center rounded bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-600/20">
                      ₹{p.walletBalance}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </Td>
                <Td
                  right
                  className={
                    isZero(p.balance)
                      ? 'text-slate-400'
                      : isNegative(p.balance)
                        ? 'text-red-700'
                        : 'text-slate-900'
                  }
                >
                  {rupees(p.balance)}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {creating && <PartyForm party={null} onClose={() => setCreating(false)} />}
    </>
  );
}

export function PartyForm({ party, onClose }: { party: Party | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: reference } = useReference();
  const [form, setForm] = useState({
    kind: (party?.kind ?? 'customer') as PartyKind,
    name: party?.name ?? '',
    phone: party?.phone ?? '',
    email: party?.email ?? '',
    gstin: party?.gstin ?? '',
    stateCode: party?.stateCode ?? '',
    billingAddress: party?.billingAddress ?? '',
    pincode: party?.pincode ?? '',
    creditDays: String(party?.creditDays ?? 0),
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });
  const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    const body = {
      kind: form.kind,
      name: form.name.trim(),
      phone: orNull(form.phone),
      email: orNull(form.email),
      gstin: orNull(form.gstin.toUpperCase()),
      stateCode: orNull(form.stateCode),
      billingAddress: orNull(form.billingAddress),
      pincode: orNull(form.pincode),
      creditDays: Number(form.creditDays) || 0,
    };
    try {
      if (party)
        await api(`/v1/parties/${party.id}`, {
          method: 'PATCH',
          body: { ...body, version: party.version },
        });
      else await api('/v1/parties', { method: 'POST', body });
      await queryClient.invalidateQueries({ queryKey: ['parties'] });
      if (party) await queryClient.invalidateQueries({ queryKey: ['party', party.id] });
      toast(party ? 'Saved' : `${body.name} added`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(err.fieldErrors);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={party ? `Edit ${party.name}` : 'New customer / supplier'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="party-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="party-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error && (
          <div className="sm:col-span-2">
            <ErrorBanner message={error} />
          </div>
        )}
        <Input
          label="Name"
          required
          autoFocus
          value={form.name}
          onChange={set('name')}
          error={errors.name}
        />
        <Select label="Type" value={form.kind} onChange={set('kind')}>
          <option value="customer">Customer</option>
          <option value="supplier">Supplier</option>
          <option value="both">Both</option>
        </Select>
        <Input
          label="Phone"
          inputMode="tel"
          value={form.phone}
          onChange={set('phone')}
          error={errors.phone}
        />
        <Input
          label="Email"
          type="email"
          value={form.email}
          onChange={set('email')}
          error={errors.email}
        />
        <Input
          label="GSTIN"
          placeholder="For B2B tax invoices"
          value={form.gstin}
          onChange={set('gstin')}
          error={errors.gstin}
          hint="State is taken from the GSTIN"
        />
        <Select
          label="State"
          value={form.stateCode}
          onChange={set('stateCode')}
          error={errors.stateCode}
          disabled={form.gstin.trim().length >= 2}
        >
          <option value="">{form.gstin.trim().length >= 2 ? 'From GSTIN' : 'Select state…'}</option>
          {reference?.states.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </Select>
        <Textarea
          label="Address"
          rows={2}
          value={form.billingAddress}
          onChange={set('billingAddress')}
          wrapperClassName="sm:col-span-2"
        />
        <Input
          label="PIN code"
          inputMode="numeric"
          value={form.pincode}
          onChange={set('pincode')}
          error={errors.pincode}
        />
        <Input
          label="Credit days"
          inputMode="numeric"
          value={form.creditDays}
          onChange={set('creditDays')}
          error={errors.creditDays}
        />
      </form>
    </Modal>
  );
}
