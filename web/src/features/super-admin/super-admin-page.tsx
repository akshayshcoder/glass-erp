import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  ExternalLink,
  Eye,
  Filter,
  IndianRupee,
  Layers,
  Lock,
  MessageSquare,
  Phone,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  Shield,
  Sliders,
  Sparkles,
  Store,
  Tag,
  UserCheck,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { api, errorMessage } from '../../api/client';
import type { PlatformPayment, SuperAdminTenant } from '../../api/types';
import { useAuth } from '../../app/auth';
import { useToast } from '../../components/ui';
import { formatDate, formatMoney, rupees, todayIso } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';

export function SuperAdminPage() {
  const { me, selectShop } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') || 'tenants';

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [perPage, setPerPage] = useState(10);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Modals
  const [onboardModalOpen, setOnboardModalOpen] = useState(false);
  const [featureModalTenant, setFeatureModalTenant] = useState<SuperAdminTenant | null>(null);
  const [paymentModalTenant, setPaymentModalTenant] = useState<SuperAdminTenant | null>(null);
  const [extendModalTenant, setExtendModalTenant] = useState<SuperAdminTenant | null>(null);
  const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);

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

  const items = useMemo(() => {
    return (tenants ?? []).filter((t) => {
      const validState = t.computedValidityState || (t as any).computed_validity_state;
      const tStatus = t.tenantStatus || (t as any).tenant_status;
      if (statusFilter && validState !== statusFilter && tStatus !== statusFilter) {
        return false;
      }
      if (q) {
        const matchName = (t.tenantName || (t as any).tenant_name || '').toLowerCase().includes(q);
        const matchLegal = (t.legalName || (t as any).legal_name || '')?.toLowerCase().includes(q);
        const matchOwner = (t.owner?.fullName || (t as any).owner?.fullName || '')?.toLowerCase().includes(q);
        const matchPhone = (t.owner?.phone || (t as any).owner?.phone || '')?.includes(q);
        const matchEmail = (t.owner?.email || (t as any).owner?.email || '')?.toLowerCase().includes(q);
        return matchName || matchLegal || matchOwner || matchPhone || matchEmail;
      }
      return true;
    });
  }, [tenants, statusFilter, q]);

  // Code generator helper (e.g. SHA952 or GL741)
  const getTenantCode = (t: SuperAdminTenant) => {
    const name = (t?.tenantName || (t as any)?.tenant_name || 'TEN').trim();
    const id = (t?.tenantId || (t as any)?.tenant_id || '101').trim();
    const letters = name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'TEN';
    const digits = id.replace(/[^0-9]/g, '').slice(0, 3) || '101';
    return `${letters}${digits}`;
  };

  const allSelected = items.length > 0 && selectedIds.length === items.length;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(items.map((t) => t.tenantId || (t as any).tenant_id));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  return (
    <div className="space-y-6">
      {/* 1. Header & Title (Matching user's reference) */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
            {activeTab === 'plans'
              ? 'Subscription Plans'
              : activeTab === 'invoices'
              ? 'Subscription Invoices'
              : activeTab === 'followups'
              ? 'Calling List & Follow-ups'
              : 'Tenants'}
          </h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-400">
            {activeTab === 'plans'
              ? 'Manage SaaS pricing packages, billing terms, and module entitlements'
              : activeTab === 'invoices'
              ? 'Track platform invoices issued to clients and subscription receivables'
              : activeTab === 'followups'
              ? 'Expiring subscriptions and payment reminder calling list'
              : 'Complete list of registered client firms, owners, plans, and statuses'}
          </p>
        </div>

        {activeTab === 'tenants' && (
          <button
            onClick={() => setOnboardModalOpen(true)}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#f59e0b] px-4 py-2.5 text-sm font-semibold text-slate-950 shadow-md transition-all hover:bg-[#d97706] active:scale-95 shrink-0"
          >
            <Plus className="size-4 stroke-[2.5]" />
            <span>New tenant</span>
          </button>
        )}
      </div>

      {/* 2. Sub-views by Tab */}
      {activeTab === 'plans' ? (
        <SubscriptionPlansView />
      ) : activeTab === 'invoices' ? (
        <SubscriptionInvoicesView tenants={tenants ?? []} />
      ) : activeTab === 'followups' ? (
        <CallingFollowupsView tenants={tenants ?? []} onExtend={(t) => setExtendModalTenant(t)} />
      ) : (
        /* MAIN TENANTS TABLE (Matching user's reference screenshot) */
        <div className="space-y-4">
          {/* Search & Filter Bar */}
          <div className="rounded-xl border border-[#1f2438] bg-[#111420] p-3 shadow-lg">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute top-3 left-3.5 size-4 text-slate-400" />
                <input
                  type="search"
                  placeholder="Search by code, firm name, owner, phone…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="block w-full rounded-lg border-0 bg-[#161a29] py-2.5 pr-4 pl-10 text-sm text-white placeholder-slate-500 ring-1 ring-[#262c42] focus:ring-2 focus:ring-amber-500 outline-none"
                />
              </div>

              {/* Status Quick Filter */}
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="hidden sm:block rounded-lg border-0 bg-[#161a29] py-2.5 px-3 text-xs font-medium text-slate-300 ring-1 ring-[#262c42] focus:ring-2 focus:ring-amber-500 outline-none"
              >
                <option value="">All Status</option>
                <option value="active">Active</option>
                <option value="grace_period">Grace Period</option>
                <option value="expired">Expired</option>
                <option value="suspended">Suspended</option>
              </select>

              {/* Filter Button with Count Badge */}
              <button
                onClick={() => setFilterDrawerOpen(!filterDrawerOpen)}
                className={`relative inline-flex items-center gap-1.5 rounded-lg p-2.5 text-slate-400 ring-1 ring-[#262c42] hover:bg-[#1a1e30] hover:text-white transition-colors ${
                  statusFilter ? 'bg-amber-500/10 text-amber-400 ring-amber-500/30' : 'bg-[#161a29]'
                }`}
                title="Filters"
              >
                <Filter className="size-4" />
                <span className="text-xs font-semibold">{statusFilter ? '1' : '0'}</span>
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 p-4 text-sm text-rose-300">
              {errorMessage(error)}
            </div>
          )}

          {/* Table Container */}
          <div className="overflow-hidden rounded-xl border border-[#1f2438] bg-[#111420] shadow-xl">
            {isLoading ? (
              <div className="flex items-center justify-center py-16 text-sm text-slate-400">
                <RefreshCw className="size-5 animate-spin mr-2 text-amber-500" />
                Loading tenants…
              </div>
            ) : items.length === 0 ? (
              <div className="py-16 text-center text-slate-400">
                <Store className="mx-auto size-10 text-slate-600 mb-2" />
                <p className="text-base font-semibold text-slate-200">No tenants found</p>
                <p className="text-xs text-slate-500 mt-1">
                  Click "+ New tenant" button above to register your first client firm.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs sm:text-sm">
                  <thead className="border-b border-[#1f2438] bg-[#141826] text-[11px] font-semibold uppercase tracking-wider text-slate-400 select-none">
                    <tr>
                      <th className="w-10 px-4 py-3.5">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                          className="size-4 rounded border-slate-700 bg-slate-800 text-amber-500 focus:ring-amber-500/30"
                        />
                      </th>
                      <th className="px-4 py-3.5">Code</th>
                      <th className="px-4 py-3.5">Firm Name</th>
                      <th className="px-4 py-3.5">Owner</th>
                      <th className="px-4 py-3.5">Mobile (Login)</th>
                      <th className="px-4 py-3.5">Plan</th>
                      <th className="px-4 py-3.5">Status</th>
                      <th className="px-4 py-3.5 text-right">Validity / Dues</th>
                      <th className="px-4 py-3.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#181c2d] text-slate-300">
                    {items.slice(0, perPage).map((t) => {
                      const tenantId = t.tenantId || (t as any).tenant_id || '';
                      const tenantName = t.tenantName || (t as any).tenant_name || 'Client';
                      const legalName = t.legalName || (t as any).legal_name;
                      const plan = t.plan || (t as any).plan || 'starter';
                      const period = t.subscriptionPeriod || (t as any).subscription_period || 'annual';
                      const tenantStatus = t.tenantStatus || (t as any).tenant_status || 'active';
                      const validityState = t.computedValidityState || (t as any).computed_validity_state || 'active';
                      const outstanding = t.outstandingDue || (t as any).outstanding_due || '0.00';
                      const validUntil = t.subscriptionValidUntil || (t as any).subscription_valid_until;
                      const code = getTenantCode(t);
                      const isSelected = selectedIds.includes(tenantId);
                      const isOverdue = parseFloat(outstanding) > 0;

                      return (
                        <tr
                          key={tenantId}
                          className={`group transition-colors ${
                            isSelected ? 'bg-[#1b2033]' : 'hover:bg-[#151928]'
                          }`}
                        >
                          {/* Checkbox */}
                          <td className="px-4 py-3.5">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelectOne(tenantId)}
                              className="size-4 rounded border-slate-700 bg-slate-800 text-amber-500 focus:ring-amber-500/30"
                            />
                          </td>

                          {/* Code (Blue tag matching reference) */}
                          <td className="px-4 py-3.5">
                            <span className="inline-block rounded border border-[#1e3a5f] bg-[#102035] px-2 py-0.5 font-mono text-[11px] font-semibold text-[#38bdf8]">
                              {code}
                            </span>
                          </td>

                          {/* Firm Name (Bold White text) */}
                          <td className="px-4 py-3.5 font-bold text-white">
                            <div>{tenantName}</div>
                            {legalName && (
                              <div className="text-[11px] font-normal text-slate-500">
                                {legalName}
                              </div>
                            )}
                          </td>

                          {/* Owner Name */}
                          <td className="px-4 py-3.5 text-slate-200">
                            {t.owner?.fullName ?? '—'}
                          </td>

                          {/* Mobile (Login) */}
                          <td className="px-4 py-3.5 font-mono text-slate-300">
                            {t.owner?.phone ?? t.owner?.email ?? '—'}
                          </td>

                          {/* Plan Badge (Amber pill matching reference) */}
                          <td className="px-4 py-3.5">
                            <span className="inline-flex items-center rounded-full border border-amber-600/30 bg-[#281b0f] px-2.5 py-0.5 text-xs font-medium text-amber-300 capitalize">
                              {plan} ({period})
                            </span>
                          </td>

                          {/* Status Badge (Green / Red / Amber pill) */}
                          <td className="px-4 py-3.5">
                            {tenantStatus === 'suspended' ? (
                              <span className="inline-flex items-center rounded-full border border-red-800 bg-red-950/40 px-2.5 py-0.5 text-xs font-medium text-red-400">
                                Suspended
                              </span>
                            ) : validityState === 'active' ? (
                              <span className="inline-flex items-center rounded-full border border-emerald-800 bg-emerald-950/40 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
                                Active
                              </span>
                            ) : validityState === 'grace_period' ? (
                              <span className="inline-flex items-center rounded-full border border-amber-800 bg-amber-950/40 px-2.5 py-0.5 text-xs font-medium text-amber-400">
                                Grace
                              </span>
                            ) : (
                              <span className="inline-flex items-center rounded-full border border-red-800 bg-red-950/40 px-2.5 py-0.5 text-xs font-medium text-red-400">
                                Expired
                              </span>
                            )}
                          </td>

                          {/* Validity / Dues */}
                          <td className="px-4 py-3.5 text-right">
                            <div className="text-xs font-medium text-slate-300">
                              {validUntil ? formatDate(validUntil) : 'Lifetime / Active'}
                            </div>
                            {isOverdue && (
                              <div className="text-[11px] font-bold text-rose-400">
                                Due: {rupees(outstanding)}
                              </div>
                            )}
                          </td>

                          {/* Actions (Login as Client, Features, Extend, Pay) */}
                          <td className="px-4 py-3.5 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {/* 1-Click Login into client ERP */}
                              <button
                                onClick={() => impersonateMutation.mutate(tenantId)}
                                disabled={impersonateMutation.isPending}
                                title="Login as Client (Open their ERP)"
                                className="inline-flex items-center gap-1 rounded-md bg-[#251d13] border border-[#f59e0b]/40 px-2.5 py-1 text-xs font-semibold text-[#f59e0b] hover:bg-[#332517] transition-all"
                              >
                                <ExternalLink className="size-3" />
                                <span>Login</span>
                              </button>

                              {/* Features on/off */}
                              <button
                                onClick={() => setFeatureModalTenant(t)}
                                title="Feature Modules on/off"
                                className="rounded-md border border-[#262c42] bg-[#161a29] px-2 py-1 text-xs font-medium text-slate-300 hover:bg-[#202538] hover:text-white transition-all"
                              >
                                <Sliders className="size-3.5" />
                              </button>

                              {/* Extend */}
                              <button
                                onClick={() => setExtendModalTenant(t)}
                                title="Extend Validity"
                                className="rounded-md border border-[#262c42] bg-[#161a29] px-2 py-1 text-xs font-medium text-slate-300 hover:bg-[#202538] hover:text-white transition-all"
                              >
                                <Calendar className="size-3.5" />
                              </button>

                              {/* Pay */}
                              <button
                                onClick={() => setPaymentModalTenant(t)}
                                title="Record Subscription Payment"
                                className="rounded-md border border-[#262c42] bg-[#161a29] px-2 py-1 text-xs font-medium text-slate-300 hover:bg-[#202538] hover:text-white transition-all"
                              >
                                <IndianRupee className="size-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination Footer (Matching reference screenshot) */}
            <div className="flex items-center justify-between border-t border-[#1f2438] bg-[#141826] px-4 py-3 text-xs text-slate-400">
              <div>
                Showing <span className="font-semibold text-white">{Math.min(items.length, perPage)}</span> of{' '}
                <span className="font-semibold text-white">{items.length}</span> tenants
              </div>

              <div className="flex items-center gap-2">
                <span>Per page</span>
                <select
                  value={perPage}
                  onChange={(e) => setPerPage(Number(e.target.value))}
                  className="rounded-lg border-0 bg-[#161a29] py-1 px-2.5 text-xs font-medium text-white ring-1 ring-[#262c42] outline-none"
                >
                  <option value={10}>10</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODALS */}

      {/* 1. Onboard Client Modal */}
      {onboardModalOpen && (
        <OnboardTenantModal
          onClose={() => setOnboardModalOpen(false)}
          onSuccess={() => {
            setOnboardModalOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['super-admin-tenants'] });
          }}
        />
      )}

      {/* 2. Feature Toggles Modal */}
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

      {/* 3. Extend Validity Modal */}
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

      {/* 4. Record Payment Modal */}
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
// SUB-VIEW: Subscription Plans
// -------------------------------------------------------------------------------------
function SubscriptionPlansView() {
  const PLANS = [
    {
      name: 'Starter Package',
      price: '₹12,000 / year',
      tag: 'Basic Billing',
      desc: 'Ideal for single shop counter billing & basic retail customers',
      features: ['GST Billing & Counter Sale', 'Customer & Supplier Ledgers', 'Cash & UPI Receipts', 'Single Branch only', 'Standard Reports'],
    },
    {
      name: 'Professional',
      price: '₹24,000 / year',
      tag: 'Most Popular',
      desc: 'Complete inventory & FIFO wallet knockoff for growing traders',
      features: ['All Starter Features', 'Advanced Stock Management', 'FIFO Advance Wallet Knockoff', 'Party Credit Limits & Dues', 'GSTR-1 JSON Return Export'],
    },
    {
      name: 'Enterprise / Multi-Branch',
      price: '₹45,000 / year',
      tag: 'Full Suite',
      desc: 'Multi-branch operations with centralized admin controls',
      features: ['All Professional Features', 'Unlimited Branch Outlets', 'Inter-branch stock transfers', 'Multi-user roles & permissions', 'Priority 24/7 Support'],
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
      {PLANS.map((p, idx) => (
        <div key={idx} className="rounded-xl border border-[#1f2438] bg-[#111420] p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-bold text-white">{p.name}</h3>
            <span className="rounded-full bg-amber-500/10 border border-amber-500/30 px-2.5 py-0.5 text-xs font-semibold text-amber-400">
              {p.tag}
            </span>
          </div>
          <p className="text-2xl font-extrabold text-amber-400">{p.price}</p>
          <p className="text-xs text-slate-400">{p.desc}</p>

          <ul className="space-y-2 border-t border-[#1f2438] pt-4 text-xs text-slate-300">
            {p.features.map((f, i) => (
              <li key={i} className="flex items-center gap-2">
                <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
                <span>{f}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------------------------------
// SUB-VIEW: Subscription Invoices
// -------------------------------------------------------------------------------------
function SubscriptionInvoicesView({ tenants }: { tenants: SuperAdminTenant[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#1f2438] bg-[#111420] shadow-xl">
      <div className="p-4 border-b border-[#1f2438] flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">Platform Subscription Invoices</h2>
        <span className="text-xs text-slate-400">Issued to clients</span>
      </div>

      <table className="w-full text-left text-xs sm:text-sm">
        <thead className="border-b border-[#1f2438] bg-[#141826] text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          <tr>
            <th className="px-4 py-3">Tenant Firm</th>
            <th className="px-4 py-3">Owner Contact</th>
            <th className="px-4 py-3">Plan Amount</th>
            <th className="px-4 py-3">Total Paid</th>
            <th className="px-4 py-3">Outstanding Due</th>
            <th className="px-4 py-3 text-right">Payment Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#181c2d] text-slate-300">
          {tenants.map((t) => {
            const tenantId = t.tenantId || (t as any).tenant_id || '';
            const tenantName = t.tenantName || (t as any).tenant_name || 'Client';
            const invoiced = t.totalInvoiced || (t as any).total_invoiced || '0.00';
            const paid = t.totalPaid || (t as any).total_paid || '0.00';
            const due = t.outstandingDue || (t as any).outstanding_due || '0.00';

            return (
              <tr key={tenantId} className="hover:bg-[#151928]">
                <td className="px-4 py-3 font-semibold text-white">{tenantName}</td>
                <td className="px-4 py-3">{t.owner?.fullName ?? '—'} ({t.owner?.phone ?? '—'})</td>
                <td className="px-4 py-3 font-mono font-medium">{rupees(invoiced)}</td>
                <td className="px-4 py-3 font-mono text-emerald-400">{rupees(paid)}</td>
                <td className="px-4 py-3 font-mono text-rose-400 font-bold">{rupees(due)}</td>
                <td className="px-4 py-3 text-right">
                  {parseFloat(due) === 0 ? (
                    <span className="rounded-full bg-emerald-950/50 border border-emerald-800 px-2 py-0.5 text-xs text-emerald-400">
                      Fully Paid
                    </span>
                  ) : (
                    <span className="rounded-full bg-rose-950/50 border border-rose-800 px-2 py-0.5 text-xs text-rose-400 font-semibold">
                      Payment Due
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// SUB-VIEW: Calling List & Follow-ups
// -------------------------------------------------------------------------------------
function CallingFollowupsView({
  tenants,
  onExtend,
}: {
  tenants: SuperAdminTenant[];
  onExtend: (t: SuperAdminTenant) => void;
}) {
  const followups = tenants.filter((t) => {
    const validity = t.computedValidityState || (t as any).computed_validity_state;
    const due = t.outstandingDue || (t as any).outstanding_due || '0';
    return validity !== 'active' || parseFloat(due) > 0;
  });

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-xs text-amber-300 flex items-center justify-between">
        <div>
          <span className="font-bold">Follow-up Call Queue: </span>
          <span>{followups.length} clients need renewal call or payment reminder</span>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-[#1f2438] bg-[#111420] shadow-xl">
        <table className="w-full text-left text-xs sm:text-sm">
          <thead className="border-b border-[#1f2438] bg-[#141826] text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-3">Client Firm</th>
              <th className="px-4 py-3">Owner Name</th>
              <th className="px-4 py-3">Mobile No.</th>
              <th className="px-4 py-3">Expiry / Due Status</th>
              <th className="px-4 py-3 text-right">Quick Contact & Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#181c2d] text-slate-300">
            {followups.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-slate-400">
                  All clients are active and fully paid up! No pending calls.
                </td>
              </tr>
            ) : (
              followups.map((t) => {
                const tenantId = t.tenantId || (t as any).tenant_id || '';
                const tenantName = t.tenantName || (t as any).tenant_name || 'Client';
                const validity = t.computedValidityState || (t as any).computed_validity_state;
                const due = t.outstandingDue || (t as any).outstanding_due || '0.00';

                return (
                  <tr key={tenantId} className="hover:bg-[#151928]">
                    <td className="px-4 py-3 font-bold text-white">{tenantName}</td>
                    <td className="px-4 py-3">{t.owner?.fullName ?? '—'}</td>
                    <td className="px-4 py-3 font-mono font-medium text-amber-400">
                      {t.owner?.phone ?? '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-rose-400 font-semibold">
                        {validity === 'expired'
                          ? 'Expired'
                          : validity === 'grace_period'
                          ? 'In Grace Period'
                          : 'Due: ' + rupees(due)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {t.owner?.phone && (
                          <a
                            href={`tel:${t.owner.phone}`}
                            className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-xs text-white hover:bg-slate-700"
                          >
                            <Phone className="size-3 text-emerald-400" />
                            <span>Call</span>
                          </a>
                        )}
                        {t.owner?.phone && (
                          <a
                            href={`https://wa.me/91${t.owner.phone.replace(/[^0-9]/g, '')}?text=Hello%20${encodeURIComponent(
                              t.owner.fullName || tenantName,
                            )},%20your%20ERP%20subscription%20renewal%20is%20due.%20Please%20contact%20us%20for%20renewal.`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 rounded bg-[#075e54] px-2 py-1 text-xs text-white hover:bg-[#128c7e]"
                          >
                            <MessageSquare className="size-3" />
                            <span>WhatsApp</span>
                          </a>
                        )}
                        <button
                          onClick={() => onExtend(t)}
                          className="rounded bg-amber-500/10 border border-amber-500/30 px-2 py-1 text-xs font-semibold text-amber-400 hover:bg-amber-500/20"
                        >
                          Extend Plan
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// MODAL 1: Onboard New Tenant (Client)
// -------------------------------------------------------------------------------------
function OnboardTenantModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
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
        body: {
          name: form.name.trim(),
          legalName: form.legalName.trim() || undefined,
          pan: form.pan.trim().toUpperCase() || undefined,
          plan: form.plan,
          subscriptionPeriod: form.subscriptionPeriod,
          subscriptionAmount: form.subscriptionAmount.trim() || '0.00',
          subscriptionValidUntil: form.subscriptionValidUntil || undefined,
          gracePeriodDays: Number(form.gracePeriodDays) || 7,
          owner: {
            fullName: form.ownerFullName.trim(),
            phone: form.ownerPhone.trim() || undefined,
            email: form.ownerEmail.trim().toLowerCase() || undefined,
            password: form.ownerPassword,
          },
          branch: {
            code: (form.branchCode || 'MAIN').trim().toUpperCase(),
            name: (form.branchName || 'Main Branch').trim(),
            stateCode: (form.stateCode || '07').trim(),
            gstin: form.gstin.trim().toUpperCase() || undefined,
          },
        },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs overflow-y-auto">
      <div className="w-full max-w-xl rounded-xl border border-[#23283d] bg-[#141724] p-6 text-white shadow-2xl space-y-4 my-8">
        <div className="flex items-center justify-between border-b border-[#23283d] pb-3">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <Store className="size-5 text-amber-500" />
            <span>Onboard New Client Tenant</span>
          </h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-white">
            <X className="size-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs sm:text-sm">
          {error && (
            <div className="rounded-lg bg-rose-950/40 border border-rose-900/60 p-3 text-rose-300">
              {error}
            </div>
          )}

          {/* Firm Profile */}
          <div className="space-y-2 border-b border-[#23283d] pb-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">Firm Profile</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Firm Name *</label>
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Sharma Jewellers & Sons"
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Legal Name</label>
                <input
                  value={form.legalName}
                  onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                  placeholder="e.g. Sharma Jewellers Pvt Ltd"
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>
          </div>

          {/* Owner Credentials */}
          <div className="space-y-2 border-b border-[#23283d] pb-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">Owner Login Details</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Owner Full Name *</label>
                <input
                  required
                  value={form.ownerFullName}
                  onChange={(e) => setForm({ ...form, ownerFullName: e.target.value })}
                  placeholder="e.g. Ramesh Sharma"
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Mobile No (Login ID)</label>
                <input
                  value={form.ownerPhone}
                  onChange={(e) => setForm({ ...form, ownerPhone: e.target.value })}
                  placeholder="e.g. 9876543210"
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Email Address</label>
                <input
                  type="email"
                  value={form.ownerEmail}
                  onChange={(e) => setForm({ ...form, ownerEmail: e.target.value })}
                  placeholder="e.g. ramesh@sharma.com"
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Initial Password * (min 8 chars)</label>
                <input
                  type="password"
                  required
                  value={form.ownerPassword}
                  onChange={(e) => setForm({ ...form, ownerPassword: e.target.value })}
                  placeholder="••••••••"
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>
          </div>

          {/* Subscription Package */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">Subscription & Validity</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Package Plan</label>
                <select
                  value={form.plan}
                  onChange={(e) => setForm({ ...form, plan: e.target.value as any })}
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                >
                  <option value="starter">Starter</option>
                  <option value="professional">Professional</option>
                  <option value="enterprise">Enterprise</option>
                  <option value="trial">Trial</option>
                </select>
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Subscription Fee (₹)</label>
                <input
                  value={form.subscriptionAmount}
                  onChange={(e) => setForm({ ...form, subscriptionAmount: e.target.value })}
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Valid Until</label>
                <input
                  type="date"
                  value={form.subscriptionValidUntil}
                  onChange={(e) => setForm({ ...form, subscriptionValidUntil: e.target.value })}
                  className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
                />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-[#23283d]">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-lg bg-slate-800 px-4 py-2 font-medium text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-[#f59e0b] px-5 py-2 font-semibold text-slate-950 hover:bg-[#d97706]"
            >
              {loading ? 'Creating…' : 'Create Client'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// MODAL 2: Feature Toggles
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

  const tenantId = tenant.tenantId || (tenant as any).tenant_id || '';
  const tenantName = tenant.tenantName || (tenant as any).tenant_name || 'Client';

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
    { key: 'billing', label: 'Billing & POS', desc: 'Generate GST bills, counter sales & quotations' },
    { key: 'inventory', label: 'Inventory & Stock Management', desc: 'Track stock units, glass cut dimensions & reorder levels' },
    { key: 'wallet_fifo', label: 'FIFO Advance Wallet Knockoff', desc: 'Automatic FIFO allocation of advance receipts against bills' },
    { key: 'purchases', label: 'Purchases & Supplier Dues', desc: 'Purchase bills entry, supplier payments & Input Tax Credit' },
    { key: 'reports', label: 'Financial Reports & GSTR-1', desc: 'Sales registers, GSTR-1 portal JSON export, stock valuations' },
    { key: 'credit_limits', label: 'Party Credit Limits & Dues', desc: 'Sanctioned credit limit checks on billing' },
    { key: 'multi_branch', label: 'Multi-Branch Support', desc: 'Add and operate multiple branches/outlets under one tenant' },
  ];

  async function handleSave() {
    setLoading(true);
    setError(null);
    try {
      await api(`/v1/super-admin/tenants/${tenantId}/features`, {
        method: 'PUT',
        body: features,
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-xl border border-[#23283d] bg-[#141724] p-6 text-white shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-[#23283d] pb-3">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Sliders className="size-4 text-amber-500" />
              <span>Feature Entitlements</span>
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">{tenantName}</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-white">
            <X className="size-5" />
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-rose-950/40 border border-rose-900/60 p-3 text-rose-300 text-xs">
            {error}
          </div>
        )}

        <div className="divide-y divide-[#202538] max-h-96 overflow-y-auto pr-1">
          {MODULES.map((m) => (
            <div key={m.key} className="flex items-center justify-between py-2.5">
              <div>
                <p className="text-sm font-semibold text-white">{m.label}</p>
                <p className="text-xs text-slate-400">{m.desc}</p>
              </div>
              <input
                type="checkbox"
                checked={features[m.key]}
                onChange={(e) => setFeatures({ ...features, [m.key]: e.target.checked })}
                className="size-5 rounded border-slate-700 bg-slate-800 text-amber-500 focus:ring-amber-500"
              />
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-[#23283d]">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="rounded-lg bg-[#f59e0b] px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-[#d97706]"
          >
            {loading ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// MODAL 3: Extend Validity
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

  const tenantId = tenant.tenantId || (tenant as any).tenant_id || '';
  const tenantName = tenant.tenantName || (tenant as any).tenant_name || 'Client';
  const validUntil = tenant.subscriptionValidUntil || (tenant as any).subscription_valid_until;

  async function handleExtend(d: number) {
    setLoading(true);
    try {
      await api(`/v1/super-admin/tenants/${tenantId}/extend-validity`, {
        method: 'POST',
        body: { days: d },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-[#23283d] bg-[#141724] p-6 text-white shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-[#23283d] pb-3">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Calendar className="size-4 text-amber-500" />
            <span>Extend Subscription Validity</span>
          </h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-white">
            <X className="size-5" />
          </button>
        </div>

        <p className="text-xs text-slate-400">
          Firm: <span className="text-white font-semibold">{tenantName}</span>
        </p>

        <p className="text-xs text-slate-400">
          Current Valid Until:{' '}
          <span className="font-semibold text-white">
            {validUntil ? formatDate(validUntil) : 'None'}
          </span>
        </p>

        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => handleExtend(30)}
            disabled={loading}
            className="rounded-lg bg-[#1a1e30] border border-[#2c324b] py-2.5 text-xs font-semibold text-slate-200 hover:border-amber-500 hover:text-amber-400"
          >
            + 30 Days (1 Mo)
          </button>
          <button
            onClick={() => handleExtend(90)}
            disabled={loading}
            className="rounded-lg bg-[#1a1e30] border border-[#2c324b] py-2.5 text-xs font-semibold text-slate-200 hover:border-amber-500 hover:text-amber-400"
          >
            + 90 Days (3 Mo)
          </button>
          <button
            onClick={() => handleExtend(365)}
            disabled={loading}
            className="rounded-lg bg-[#251d13] border border-amber-500/40 py-2.5 text-xs font-semibold text-amber-400 hover:bg-[#332517]"
          >
            + 365 Days (1 Yr)
          </button>
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// MODAL 4: Record Client Payment
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

  const tenantId = tenant.tenantId || (tenant as any).tenant_id || '';
  const tenantName = tenant.tenantName || (tenant as any).tenant_name || 'Client';
  const outstanding = tenant.outstandingDue || (tenant as any).outstanding_due || '0.00';

  const [amount, setAmount] = useState(
    outstanding !== '0.00' ? outstanding : '12000.00',
  );
  const [mode, setMode] = useState<'upi' | 'bank_transfer' | 'cheque' | 'cash'>('upi');
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');

  async function handleRecord(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api(`/v1/super-admin/tenants/${tenantId}/payments`, {
        method: 'POST',
        body: {
          amount: amount.trim(),
          mode,
          referenceNo: referenceNo.trim() || undefined,
          notes: notes.trim() || undefined,
        },
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-[#23283d] bg-[#141724] p-6 text-white shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b border-[#23283d] pb-3">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <IndianRupee className="size-4 text-emerald-400" />
            <span>Record Client Subscription Payment</span>
          </h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-white">
            <X className="size-5" />
          </button>
        </div>

        <p className="text-xs text-slate-400">
          Firm: <span className="text-white font-semibold">{tenantName}</span>
        </p>

        <form onSubmit={handleRecord} className="space-y-3 text-xs sm:text-sm">
          <div>
            <label className="block text-slate-400 mb-1">Amount Received (₹) *</label>
            <input
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
            />
          </div>

          <div>
            <label className="block text-slate-400 mb-1">Payment Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as any)}
              className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
            >
              <option value="upi">UPI (PhonePe / GPay / Paytm)</option>
              <option value="bank_transfer">Bank Transfer (NEFT / RTGS)</option>
              <option value="cheque">Cheque</option>
              <option value="cash">Cash</option>
            </select>
          </div>

          <div>
            <label className="block text-slate-400 mb-1">Transaction Ref / UTR No.</label>
            <input
              value={referenceNo}
              onChange={(e) => setReferenceNo(e.target.value)}
              placeholder="e.g. UPI Ref # 1234567890"
              className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
            />
          </div>

          <div>
            <label className="block text-slate-400 mb-1">Notes</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Annual renewal fees"
              className="w-full rounded-lg bg-[#1a1e30] border border-[#2c324b] px-3 py-2 text-white outline-none focus:border-amber-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-[#23283d]">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-[#f59e0b] px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-[#d97706]"
            >
              {loading ? 'Recording…' : 'Record Payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
