import { ChevronRight, Store } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, api, errorMessage } from '../../api/client';
import { useAuth } from '../../app/auth';
import { useReference } from '../../app/shop-data';
import { Button, Card, ErrorBanner, Input, Select } from '../../components/ui';

/** Choose which shop to work in, or create a new one. */
export function ShopsPage() {
  const { me, selectShop, reloadMe, signOut } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const open = (tenantId: string) => {
    selectShop(tenantId);
    navigate('/');
  };

  const shops = me?.memberships ?? [];
  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-brand-700">Glass ERP</p>
          <h1 className="text-2xl font-semibold text-slate-900">Hello, {me?.user.fullName}</h1>
        </div>
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </div>

      {shops.length > 0 && (
        <Card className="mb-6 divide-y divide-slate-100">
          {shops.map((m) => (
            <button
              key={m.tenantId}
              onClick={() => open(m.tenantId)}
              className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-slate-50"
            >
              <Store className="size-5 text-brand-700" aria-hidden />
              <div className="flex-1">
                <p className="font-medium text-slate-900">{m.tenantName}</p>
                <p className="text-xs text-slate-500 capitalize">{m.role}</p>
              </div>
              <ChevronRight className="size-4 text-slate-400" aria-hidden />
            </button>
          ))}
        </Card>
      )}

      {creating || shops.length === 0 ? (
        <CreateShopForm
          onCreated={async (id) => {
            await reloadMe();
            open(id);
          }}
          onCancel={shops.length ? () => setCreating(false) : undefined}
        />
      ) : (
        <Button variant="secondary" onClick={() => setCreating(true)}>
          + Create another shop
        </Button>
      )}
    </div>
  );
}

function CreateShopForm({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { data: reference } = useReference();
  const [form, setForm] = useState({
    name: '',
    legalName: '',
    branchCode: 'MAIN',
    branchName: 'Main shop',
    address: '',
    city: '',
    pincode: '',
    stateCode: '',
    phone: '',
    email: '',
    gstin: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      const gstin = form.gstin.trim().toUpperCase();
      const legalName = form.legalName.trim();
      const address = form.address.trim();
      const city = form.city.trim();
      const pincode = form.pincode.trim();
      const phone = form.phone.trim();
      const email = form.email.trim();
      const tenant = await api<{ id: string }>('/v1/tenants', {
        method: 'POST',
        noTenant: true,
        body: {
          name: form.name.trim(),
          ...(legalName && { legalName }),
          branch: {
            code: form.branchCode,
            name: form.branchName,
            stateCode: form.stateCode,
            ...(gstin && { gstin }),
            ...(address && { address }),
            ...(city && { city }),
            ...(pincode && { pincode }),
            ...(phone && { phone }),
            ...(email && { email }),
          },
        },
      });
      await onCreated(tenant.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VALIDATION_FAILED') setErrors(err.fieldErrors);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="text-base font-semibold text-slate-900">Set up your shop</h2>
      <p className="mt-1 mb-5 text-sm text-slate-500">
        Enter your shop and address details (printed on bills &amp; GST invoices).
      </p>
      <form onSubmit={submit} className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Shop name"
            required
            autoFocus
            value={form.name}
            onChange={set('name')}
            error={errors.name}
          />
          <Input
            label="Legal / GST trade name (optional)"
            placeholder="Same as shop name if blank"
            value={form.legalName}
            onChange={set('legalName')}
            error={errors.legalName}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Input
            label="Branch code"
            required
            maxLength={4}
            hint="On bill numbers"
            value={form.branchCode}
            onChange={(e) => setForm({ ...form, branchCode: e.target.value.toUpperCase() })}
            error={errors['branch.code']}
          />
          <Input
            label="Branch name"
            required
            wrapperClassName="col-span-2"
            value={form.branchName}
            onChange={set('branchName')}
            error={errors['branch.name']}
          />
        </div>

        <div className="border-t border-slate-200 pt-3">
          <p className="mb-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Full Shop Address &amp; Contact (Displayed on Billing)
          </p>
          <div className="space-y-3">
            <Input
              label="Full address (Street / Market / Landmark)"
              required
              placeholder="e.g. Shop No. 12, Timber Market, Near Station Road"
              value={form.address}
              onChange={set('address')}
              error={errors['branch.address']}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                label="City"
                required
                placeholder="e.g. Mumbai"
                value={form.city}
                onChange={set('city')}
                error={errors['branch.city']}
              />
              <Input
                label="PIN code"
                maxLength={6}
                placeholder="6-digit PIN"
                value={form.pincode}
                onChange={set('pincode')}
                error={errors['branch.pincode']}
              />
              <Select
                label="State"
                required
                value={form.stateCode}
                onChange={set('stateCode')}
                error={errors['branch.stateCode']}
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
                label="Shop phone number"
                inputMode="tel"
                placeholder="e.g. 9876543210"
                value={form.phone}
                onChange={set('phone')}
                error={errors['branch.phone']}
              />
              <Input
                label="Shop email (optional)"
                type="email"
                placeholder="e.g. billing@shop.com"
                value={form.email}
                onChange={set('email')}
                error={errors['branch.email']}
              />
            </div>
          </div>
        </div>

        <Input
          label="GSTIN"
          placeholder="Leave empty if not registered"
          value={form.gstin}
          onChange={set('gstin')}
          error={errors['branch.gstin']}
        />
        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Create shop
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}
