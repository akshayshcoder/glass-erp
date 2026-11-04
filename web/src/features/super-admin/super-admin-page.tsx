import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  IndianRupee,
  Layers,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sliders,
  UserCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { PlatformPayment, SuperAdminTenant } from '../../api/types';
import { useAuth } from '../../app/auth';
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
  Th,
  useToast,
} from '../../components/ui';
import { formatDate, formatMoney, rupees, todayIso } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';

export function SuperAdminPage() {
  const { me, selectShop } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [onboardModalOpen, setOnboardModalOpen] = useState(false);
  const [featureModalTenant, setFeatureModalTenant] = useState<SuperAdminTenant | null>(null);
  const [paymentModalTenant, setPaymentModalTenant] = useState<SuperAdminTenant | null>(null);
  const [extendModalTenant, setExtendModalTenant] = useState<SuperAdminTenant | null>(null);

  const q = useDebounced(search.trim().toLowerCase(), 200);

  const { data: tenants, isLoading, error } = useQuery({
    queryKey: ['super-admin-tenants'],
    queryFn: () => api<SuperAdminTenant[]>('/v1/super-admin/tenants'),
  });

  const impersonateMutation = useMutation({
    mutationFn: async (tenantId: string) => {
      const res = await api<{ tenantId: string; tenantName: string }>(
        `/v1/super-admin/impersonate/${tenantId}`,
        { method: 'POST' },
      );
      return res;
    },
    onSuccess: (res) => {
      selectShop(res.tenantId);
      toast(`Switched to client: ${res.tenantName}`, 'success');
      navigate('/');
    },
    onError: (err) => {
      toast(errorMessage(err), 'error');
    },
  });

  if (!me?.user.isPlatformAdmin) {
    return (
      <Card className="p-8 text-center">
        <Shield className="mx-auto size-12 text-slate-400 mb-3" />
        <h2 className="text-lg font-bold text-slate-900">Access Restricted</h2>
        <p className="mt-1 text-sm text-slate-500">
          Super Admin permissions are required to manage platform clients and subscriptions.
        </p>
      </Card>
    );
  }

  const items = (tenants ?? []).filter((t) => {
    if (statusFilter && t.computedValidityState !== statusFilter && t.tenantStatus !== statusFilter) {
      return false;
    }
    if (q) {
      const matchName = t.tenantName.toLowerCase().includes(q);
      const matchOwner = t.owner?.fullName?.toLowerCase().includes(q);
      const matchPhone = t.owner?.phone?.includes(q);
      const matchEmail = t.owner?.email?.toLowerCase().includes(q);
      return matchName || matchOwner || matchPhone || matchEmail;
    }
    return true;
  });

  // Overview metrics
  const totalClients = tenants?.length ?? 0;
  const activeSubs = tenants?.filter((t) => t.computedValidityState === 'active' && t.tenantStatus === 'active').length ?? 0;
  const graceOrExpired = tenants?.filter((t) => t.computedValidityState === 'grace_period' || t.computedValidityState === 'expired').length ?? 0;
  const totalDues = (tenants ?? []).reduce((acc, t) => acc + (parseFloat(t.outstandingDue) || 0), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Super Admin Console"
        subtitle="Manage client tenants, subscription cycles, feature entitlements, and payment dues"
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setOnboardModalOpen(true)}>
            Onboard Client
          </Button>
        }
      />

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Card className="p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Clients</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{totalClients}</p>
          </div>
          <Building2 className="size-8 text-brand-600 bg-brand-50 p-1.5 rounded-lg" />
        </Card>

        <Card className="p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Active Subscriptions</p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">{activeSubs}</p>
          </div>
          <CheckCircle2 className="size-8 text-emerald-600 bg-emerald-50 p-1.5 rounded-lg" />
        </Card>

        <Card className="p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Grace / Expiring Soon</p>
            <p className="mt-1 text-2xl font-bold text-amber-700">{graceOrExpired}</p>
          </div>
          <Clock className="size-8 text-amber-600 bg-amber-50 p-1.5 rounded-lg" />
        </Card>

        <Card className="p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Total Outstanding Dues</p>
            <p className="mt-1 text-2xl font-bold text-rose-700">{rupees(totalDues.toFixed(2))}</p>
          </div>
          <IndianRupee className="size-8 text-rose-600 bg-rose-50 p-1.5 rounded-lg" />
        </Card>
      </div>

      {/* Main Clients Table */}
      <Card>
        <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-3 border-b border-slate-200 p-3 sm:p-4">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" />
            <input
              type="search"
              placeholder="Search by client name, owner, phone, email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="block w-full rounded-md border-0 py-2 pr-3 pl-9 text-sm ring-1 ring-slate-300 ring-inset focus:ring-2 focus:ring-brand-600"
            />
          </div>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="w-full sm:w-44"
          >
            <option value="">All Health Status</option>
            <option value="active">Active & Healthy</option>
            <option value="grace_period">In Grace Period</option>
            <option value="expired">Expired / Due</option>
            <option value="suspended">Suspended by Admin</option>
          </Select>
        </div>

        {error && (
          <div className="p-4">
            <ErrorBanner message={errorMessage(error)} />
          </div>
        )}

        {isLoading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState title="No clients found">
            <p className="text-xs text-slate-500">Onboard a new client using the button above.</p>
          </EmptyState>
        ) : (
          <Table
            head={
              <>
                <Th>Client / Shop</Th>
                <Th>Owner Contact</Th>
                <Th>Plan & Cycle</Th>
                <Th>Valid Until</Th>
                <Th right>Outstanding Due</Th>
                <Th>Status</Th>
                <Th right>Actions</Th>
              </>
            }
          >
            {items.map((t) => {
              const isOverdue = parseFloat(t.outstandingDue) > 0;
              return (
                <tr key={t.tenantId} className="hover:bg-slate-50">
                  <Td className="font-medium text-slate-900">
                    <div>{t.tenantName}</div>
                    {t.legalName && <div className="text-xs text-slate-500 font-normal">{t.legalName}</div>}
                  </Td>
                  <Td>
                    <div>{t.owner?.fullName ?? 'No owner'}</div>
                    <div className="text-xs text-slate-500">{t.owner?.phone ?? t.owner?.email ?? '—'}</div>
                  </Td>
                  <Td>
                    <span className="capitalize font-medium text-slate-800">{t.plan}</span>
                    <span className="text-xs text-slate-500 block capitalize">{t.subscriptionPeriod}</span>
                  </Td>
                  <Td>
                    {t.subscriptionValidUntil ? (
                      <div>
                        <div>{formatDate(t.subscriptionValidUntil)}</div>
                        <span
                          className={`text-xs font-medium ${
                            t.computedValidityState === 'active'
                              ? 'text-emerald-700'
                              : t.computedValidityState === 'grace_period'
                              ? 'text-amber-700'
                              : 'text-rose-700 font-semibold'
                          }`}
                        >
                          {t.computedValidityState === 'active'
                            ? 'Valid'
                            : t.computedValidityState === 'grace_period'
                            ? 'Grace Period'
                            : 'Expired'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-slate-400">Unlimited / Trial</span>
                    )}
                  </Td>
                  <Td right className={isOverdue ? 'font-bold text-rose-700' : 'text-slate-600'}>
                    {rupees(t.outstandingDue)}
                  </Td>
                  <Td>
                    {t.tenantStatus === 'suspended' ? (
                      <Badge tone="red">Suspended</Badge>
                    ) : t.computedValidityState === 'active' ? (
                      <Badge tone="green">Active</Badge>
                    ) : t.computedValidityState === 'grace_period' ? (
                      <Badge tone="amber">Grace Period</Badge>
                    ) : (
                      <Badge tone="red">Expired</Badge>
                    )}
                  </Td>
                  <Td right>
                    <div className="flex items-center justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="secondary"
                        title="Configure Features & Modules"
                        onClick={() => setFeatureModalTenant(t)}
                        icon={<Sliders className="size-3.5" />}
                      >
                        Features
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        title="Extend subscription validity"
                        onClick={() => setExtendModalTenant(t)}
                        icon={<Calendar className="size-3.5" />}
                      >
                        Extend
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        title="Record payment collected from client"
                        onClick={() => setPaymentModalTenant(t)}
                        icon={<IndianRupee className="size-3.5" />}
                      >
                        Pay
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        title="Login as Client (Support mode)"
                        onClick={() => impersonateMutation.mutate(t.tenantId)}
                        disabled={impersonateMutation.isPending}
                        icon={<ExternalLink className="size-3.5" />}
                      >
                        Login
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {/* Onboard Client Modal */}
      {onboardModalOpen && (
        <OnboardClientModal
          onClose={() => setOnboardModalOpen(false)}
          onSuccess={() => {
            setOnboardModalOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['super-admin-tenants'] });
          }}
        />
      )}

      {/* Feature Toggles Modal */}
      {featureModalTenant && (
        <FeatureTogglesModal
          tenant={featureModalTenant}
          onClose={() => setFeatureModalTenant(null)}
          onSuccess={() => {
            setFeatureModalTenant(null);
            void queryClient.invalidateQueries({ queryKey: ['super-admin-tenants'] });
          }}
        />
      )}

      {/* Extend Validity Modal */}
      {extendModalTenant && (
        <ExtendValidityModal
          tenant={extendModalTenant}
          onClose={() => setExtendModalTenant(null)}
          onSuccess={() => {
            setExtendModalTenant(null);
            void queryClient.invalidateQueries({ queryKey: ['super-admin-tenants'] });
          }}
        />
      )}

      {/* Record Payment Modal */}
      {paymentModalTenant && (
        <RecordPaymentModal
          tenant={paymentModalTenant}
          onClose={() => setPaymentModalTenant(null)}
          onSuccess={() => {
            setPaymentModalTenant(null);
            void queryClient.invalidateQueries({ queryKey: ['super-admin-tenants'] });
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------
// 1. Onboard Client Modal
// -------------------------------------------------------------------------------------
function OnboardClientModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    legalName: '',
    pan: '',
    plan: 'starter' as const,
    subscriptionPeriod: 'annual' as const,
    subscriptionAmount: '12000.00',
    subscriptionValidUntil: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
    gracePeriodDays: 7,
    ownerFullName: '',
    ownerPhone: '',
    ownerEmail: '',
    ownerPassword: '',
    branchName: 'Main Branch',
    branchCode: 'MAIN',
    stateCode: '07',
    gstin: '',
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await api('/v1/super-admin/tenants', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          legalName: form.legalName || undefined,
          pan: form.pan || undefined,
          plan: form.plan,
          subscriptionPeriod: form.subscriptionPeriod,
          subscriptionAmount: form.subscriptionAmount,
          subscriptionValidUntil: form.subscriptionValidUntil || undefined,
          gracePeriodDays: form.gracePeriodDays,
          owner: {
            fullName: form.ownerFullName,
            phone: form.ownerPhone || undefined,
            email: form.ownerEmail || undefined,
            password: form.ownerPassword,
          },
          branch: {
            code: form.branchCode,
            name: form.branchName,
            stateCode: form.stateCode,
            gstin: form.gstin || undefined,
          },
        }),
      });

      toast('Client onboarded successfully!', 'success');
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Onboard New Client">
      <form onSubmit={handleSubmit} className="space-y-4">
        {error && <ErrorBanner message={error} />}

        <div className="border-b border-slate-200 pb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Shop / Business Profile</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">Business Name *</label>
              <Input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Royal Glass House"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Legal Name</label>
              <Input
                value={form.legalName}
                onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                placeholder="e.g. Royal Glass Private Limited"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Branch Code (for bill series) *</label>
              <Input
                required
                value={form.branchCode}
                onChange={(e) => setForm({ ...form, branchCode: e.target.value.toUpperCase() })}
                placeholder="e.g. MAIN"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">State Code (2 digits) *</label>
              <Input
                required
                value={form.stateCode}
                onChange={(e) => setForm({ ...form, stateCode: e.target.value })}
                placeholder="e.g. 07"
              />
            </div>
          </div>
        </div>

        <div className="border-b border-slate-200 pb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Client Owner (Login Credentials)</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">Owner Full Name *</label>
              <Input
                required
                value={form.ownerFullName}
                onChange={(e) => setForm({ ...form, ownerFullName: e.target.value })}
                placeholder="e.g. Ajay Sharma"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Phone Number (Login identifier)</label>
              <Input
                value={form.ownerPhone}
                onChange={(e) => setForm({ ...form, ownerPhone: e.target.value })}
                placeholder="e.g. 9876543210"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Email Address</label>
              <Input
                type="email"
                value={form.ownerEmail}
                onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
                placeholder="e.g. ajay@example.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Initial Password * (min 8 chars)</label>
              <Input
                type="password"
                required
                value={form.ownerPassword}
                onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })}
                placeholder="••••••••"
              />
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">Subscription & Pricing</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700">Plan</label>
              <Select
                value={form.plan}
                onChange={(e) => setForm({ ...form, plan: e.target.value as any })}
              >
                <option value="starter">Starter</option>
                <option value="professional">Professional</option>
                <option value="enterprise">Enterprise</option>
                <option value="trial">Trial</option>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Billing Cycle</label>
              <Select
                value={form.subscriptionPeriod}
                onChange={(e) => setForm({ ...form, subscriptionPeriod: e.target.value as any })}
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
                <option value="lifetime">Lifetime</option>
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Subscription Fee (₹)</label>
              <Input
                value={form.subscriptionAmount}
                onChange={(e) => setForm({ ...form, subscriptionAmount: e.target.value })}
                placeholder="12000.00"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Valid Until</label>
              <Input
                type="date"
                value={form.subscriptionValidUntil}
                onChange={(e) => setForm({ ...form, subscriptionValidUntil: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Grace Period (Days)</label>
              <Input
                type="number"
                value={form.gracePeriodDays}
                onChange={(e) => setForm({ ...form, gracePeriodDays: parseInt(e.target.value) || 0 })}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? 'Creating…' : 'Create Client'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------
// 2. Feature Toggles Modal
// -------------------------------------------------------------------------------------
function FeatureTogglesModal({
  tenant,
  onClose,
  onSuccess,
}: {
  tenant: SuperAdminTenant;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [features, setFeatures] = useState({
    billing: tenant.features?.billing ?? true,
    inventory: tenant.features?.inventory ?? true,
    wallet_fifo: tenant.features?.wallet_fifo ?? true,
    purchases: tenant.features?.purchases ?? true,
    reports: tenant.features?.reports ?? true,
    credit_limits: tenant.features?.credit_limits ?? true,
    multi_branch: tenant.features?.multi_branch ?? false,
  });

  const MODULES: { key: keyof typeof features; label: string; desc: string }[] = [
    { key: 'billing', label: 'Billing & POS', desc: 'Generate GST tax bills, customer walk-in sales & quotations' },
    { key: 'inventory', label: 'Inventory & Products', desc: 'Stock quantities, custom glass cut pricing & reorder levels' },
    { key: 'wallet_fifo', label: 'FIFO Advance Wallet', desc: 'Automatic FIFO knockoff of customer advance receipts against invoices' },
    { key: 'purchases', label: 'Purchases & Supplier Dues', desc: 'Purchase bills entry, supplier payments & Input Tax Credit (ITC)' },
    { key: 'reports', label: 'Reports & GSTR-1', desc: 'Sales registers, GSTR-1 portal export, dues aging & stock valuations' },
    { key: 'credit_limits', label: 'Party Credit Limits', desc: 'Restrict bill posting if party crosses sanctioned credit limit' },
    { key: 'multi_branch', label: 'Multi-Branch Support', desc: 'Allow client to add and operate multiple shop branches' },
  ];

  async function handleSave() {
    setLoading(true);
    setError(null);
    try {
      await api(`/v1/super-admin/tenants/${tenant.tenantId}/features`, {
        method: 'PUT',
        body: JSON.stringify(features),
      });
      toast('Features updated successfully', 'success');
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Feature Entitlements · ${tenant.tenantName}`}>
      <div className="space-y-4">
        {error && <ErrorBanner message={error} />}
        <p className="text-xs text-slate-500">
          Enable or disable specific modules for this client according to their subscription package.
        </p>

        <div className="divide-y divide-slate-100">
          {MODULES.map((m) => (
            <div key={m.key} className="flex items-center justify-between py-2.5">
              <div>
                <p className="text-sm font-semibold text-slate-900">{m.label}</p>
                <p className="text-xs text-slate-500">{m.desc}</p>
              </div>
              <input
                type="checkbox"
                checked={features[m.key]}
                onChange={(e) => setFeatures({ ...features, [m.key]: e.target.checked })}
                className="size-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? 'Saving…' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------
// 3. Extend Validity Modal
// -------------------------------------------------------------------------------------
function ExtendValidityModal({
  tenant,
  onClose,
  onSuccess,
}: {
  tenant: SuperAdminTenant;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);

  async function handleExtend(d: number) {
    setLoading(true);
    try {
      await api(`/v1/super-admin/tenants/${tenant.tenantId}/extend-validity`, {
        method: 'POST',
        body: JSON.stringify({ days: d }),
      });
      toast(`Subscription extended by ${d} days!`, 'success');
      onSuccess();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Extend Subscription · ${tenant.tenantName}`}>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Current Validity:{' '}
          <span className="font-semibold text-slate-900">
            {tenant.subscriptionValidUntil ? formatDate(tenant.subscriptionValidUntil) : 'None'}
          </span>
        </p>

        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="secondary"
            onClick={() => handleExtend(30)}
            disabled={loading}
          >
            + 30 Days (1 Mo)
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleExtend(90)}
            disabled={loading}
          >
            + 90 Days (3 Mo)
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleExtend(365)}
            disabled={loading}
          >
            + 365 Days (1 Yr)
          </Button>
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------
// 4. Record Payment Modal
// -------------------------------------------------------------------------------------
function RecordPaymentModal({
  tenant,
  onClose,
  onSuccess,
}: {
  tenant: SuperAdminTenant;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState(tenant.outstandingDue !== '0.00' ? tenant.outstandingDue : '12000.00');
  const [mode, setMode] = useState<'upi' | 'bank_transfer' | 'cheque' | 'cash'>('upi');
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');

  async function handleRecord(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api(`/v1/super-admin/tenants/${tenant.tenantId}/payments`, {
        method: 'POST',
        body: JSON.stringify({
          amount,
          mode,
          referenceNo: referenceNo || undefined,
          notes: notes || undefined,
        }),
      });
      toast('Payment recorded successfully', 'success');
      onSuccess();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Record Client Payment · ${tenant.tenantName}`}>
      <form onSubmit={handleRecord} className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-slate-700">Amount Received (₹) *</label>
          <Input
            required
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">Payment Mode</label>
          <Select value={mode} onChange={(e) => setMode(e.target.value as any)}>
            <option value="upi">UPI (GPay / PhonePe / Paytm)</option>
            <option value="bank_transfer">Bank Transfer (NEFT / IMPS / RTGS)</option>
            <option value="cheque">Cheque</option>
            <option value="cash">Cash</option>
          </Select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">Transaction / Reference No.</label>
          <Input
            value={referenceNo}
            onChange={(e) => setReferenceNo(e.target.value)}
            placeholder="e.g. UPI Ref # 1234567890"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-700">Notes</label>
          <Input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Annual renewal subscription fee"
          />
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            {loading ? 'Recording…' : 'Record Payment'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
