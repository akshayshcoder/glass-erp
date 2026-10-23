import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { ApiError, api, errorMessage } from '../../api/client';
import type { Branch, Tenant } from '../../api/types';
import { useAuth, useCan } from '../../app/auth';
import { useBranches, useReference, useStateName } from '../../app/shop-data';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorBanner,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  useToast,
} from '../../components/ui';

/** Format a branch's full address line for display on billing and settings screens. */
export function formatBranchAddress(
  branch: Branch | null | undefined,
  stateName: (code: string | null) => string,
): string {
  if (!branch) return '';
  const line = [branch.address, branch.city].filter(Boolean).join(', ');
  const statePin = [stateName(branch.stateCode), branch.pincode].filter(Boolean).join(' - ');
  return [line, statePin].filter(Boolean).join(', ');
}

/** Shop locations. Each bills under its own GSTIN, address and number series. */
export function BranchesPage() {
  const canManage = useCan('manageShop'); // Owner only
  const stateName = useStateName();
  const { data: tenant } = useQuery({
    queryKey: ['tenant'],
    queryFn: () => api<Tenant>('/v1/tenant'),
  });
  const { data, isLoading, error } = useBranches();
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  const [editingShop, setEditingShop] = useState(false);

  return (
    <>
      <PageHeader
        title="Shop & Branches"
        subtitle="Shop details, full address and GSTIN printed on bills (editable by Shop Owner only)"
        actions={
          canManage && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              Add branch
            </Button>
          )
        }
      />

      {tenant && (
        <Card className="mb-6 flex items-center justify-between p-5">
          <div>
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              SaaS Shop Details
            </p>
            <p className="mt-1 text-base font-semibold text-slate-900">{tenant.name}</p>
            <p className="text-sm text-slate-500">
              {[
                tenant.legalName ? `Legal name: ${tenant.legalName}` : null,
                tenant.pan ? `PAN: ${tenant.pan}` : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'No separate legal name or PAN set'}
            </p>
          </div>
          {canManage && (
            <Button
              variant="secondary"
              icon={<Pencil className="size-4" />}
              onClick={() => setEditingShop(true)}
            >
              Edit shop
            </Button>
          )}
        </Card>
      )}

      <Card>
        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}
        {isLoading || !data ? (
          <Spinner />
        ) : (
          <Table
            head={
              <>
                <Th>Code</Th>
                <Th>Branch Name</Th>
                <Th>Full Address</Th>
                <Th>Phone / Email</Th>
                <Th>GSTIN</Th>
                <Th>Status</Th>
              </>
            }
          >
            {data.map((b) => (
              <tr
                key={b.id}
                className={canManage ? 'cursor-pointer hover:bg-slate-50' : ''}
                onClick={() => canManage && setEditing(b)}
              >
                <Td className="font-medium text-slate-900">{b.code}</Td>
                <Td className="font-medium text-slate-900">{b.name}</Td>
                <Td className="max-w-xs text-slate-600">
                  {b.address || b.city ? (
                    formatBranchAddress(b, stateName)
                  ) : (
                    <span className="text-amber-600">
                      Address not set ({stateName(b.stateCode)})
                    </span>
                  )}
                </Td>
                <Td className="text-slate-600">
                  {[b.phone, b.email].filter(Boolean).join(' · ') || '—'}
                </Td>
                <Td>{b.gstin ?? <Badge>Unregistered</Badge>}</Td>
                <Td>{b.isActive ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && (
        <BranchModal branch={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {editingShop && tenant && (
        <ShopModal tenant={tenant} onClose={() => setEditingShop(false)} />
      )}
    </>
  );
}

function ShopModal({ tenant, onClose }: { tenant: Tenant; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { reloadMe } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({
    name: tenant.name,
    legalName: tenant.legalName ?? '',
    pan: tenant.pan ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await api('/v1/tenant', {
        method: 'PATCH',
        body: {
          version: tenant.version,
          name: form.name.trim(),
          legalName: form.legalName.trim() || null,
          pan: form.pan.trim().toUpperCase() || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['tenant'] });
      await reloadMe();
      toast('Shop details saved');
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
      onClose={onClose}
      title="Edit shop details"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="shop-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="shop-form" onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <Input
          label="Shop name"
          required
          autoFocus
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          error={errors.name}
        />
        <Input
          label="Legal / GST trade name"
          placeholder="Printed on tax invoices if different from shop name"
          value={form.legalName}
          onChange={(e) => setForm({ ...form, legalName: e.target.value })}
          error={errors.legalName}
        />
        <Input
          label="PAN"
          maxLength={10}
          placeholder="e.g. ABCDE1234F"
          value={form.pan}
          onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })}
          error={errors.pan}
        />
      </form>
    </Modal>
  );
}

export function BranchModal({
  branch,
  onClose,
}: {
  branch: Branch | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: reference } = useReference();
  const [form, setForm] = useState({
    code: branch?.code ?? '',
    name: branch?.name ?? '',
    address: branch?.address ?? '',
    city: branch?.city ?? '',
    pincode: branch?.pincode ?? '',
    stateCode: branch?.stateCode ?? '',
    phone: branch?.phone ?? '',
    email: branch?.email ?? '',
    gstin: branch?.gstin ?? '',
    isActive: branch?.isActive ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    const gstin = form.gstin.trim().toUpperCase() || null;
    const address = form.address.trim() || null;
    const city = form.city.trim() || null;
    const pincode = form.pincode.trim() || null;
    const phone = form.phone.trim() || null;
    const email = form.email.trim() || null;
    try {
      if (branch) {
        await api(`/v1/branches/${branch.id}`, {
          method: 'PATCH',
          body: {
            version: branch.version,
            name: form.name.trim(),
            address,
            city,
            pincode,
            stateCode: form.stateCode,
            phone,
            email,
            gstin,
            isActive: form.isActive,
          },
        });
      } else {
        await api('/v1/branches', {
          method: 'POST',
          body: {
            code: form.code.trim(),
            name: form.name.trim(),
            stateCode: form.stateCode,
            ...(address && { address }),
            ...(city && { city }),
            ...(pincode && { pincode }),
            ...(phone && { phone }),
            ...(email && { email }),
            ...(gstin && { gstin }),
          },
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['branches'] });
      toast(branch ? 'Branch & address saved' : 'Branch added');
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
      onClose={onClose}
      title={branch ? `Edit ${branch.name} (Address & Details)` : 'Add branch'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="branch-form" loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <form id="branch-form" onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Code"
            required
            maxLength={4}
            disabled={!!branch}
            hint="Can't change later"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
            error={errors.code}
          />
          <Input
            label="Branch name"
            required
            wrapperClassName="col-span-2"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            error={errors.name}
          />
        </div>
        <Input
          label="Full address (Street / Market / Landmark)"
          required
          placeholder="e.g. Shop No. 12, Timber Market, Station Road"
          value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })}
          error={errors.address}
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="City"
            required
            placeholder="e.g. Mumbai"
            value={form.city}
            onChange={(e) => setForm({ ...form, city: e.target.value })}
            error={errors.city}
          />
          <Input
            label="PIN code"
            maxLength={6}
            placeholder="6-digit PIN"
            value={form.pincode}
            onChange={(e) => setForm({ ...form, pincode: e.target.value })}
            error={errors.pincode}
          />
          <Select
            label="State"
            required
            value={form.stateCode}
            onChange={(e) => setForm({ ...form, stateCode: e.target.value })}
            error={errors.stateCode}
          >
            <option value="">Select state…</option>
            {reference?.states.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Phone"
            inputMode="tel"
            placeholder="e.g. 9876543210"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            error={errors.phone}
          />
          <Input
            label="Email"
            type="email"
            placeholder="e.g. billing@shop.com"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            error={errors.email}
          />
        </div>
        <Input
          label="GSTIN"
          placeholder="Leave empty if not registered"
          value={form.gstin}
          onChange={(e) => setForm({ ...form, gstin: e.target.value })}
          error={errors.gstin}
        />
        {branch && (
          <Checkbox
            label="Active"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
        )}
      </form>
    </Modal>
  );
}
