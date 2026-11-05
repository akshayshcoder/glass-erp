import {
  Building2,
  ChevronDown,
  ChevronRight,
  FileText,
  Home,
  LayoutDashboard,
  LogOut,
  Menu,
  PhoneCall,
  Shield,
  ShoppingBag,
  Sliders,
  Sparkles,
  Store,
  Tag,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../app/auth';

interface NavSection {
  title?: string;
  items: {
    to: string;
    label: string;
    icon: typeof Home;
    badge?: string;
    end?: boolean;
  }[];
}

const SA_NAV: NavSection[] = [
  {
    items: [
      { to: '/super-admin', label: 'Dashboard', icon: Home, end: true },
    ],
  },
  {
    title: 'Client Management',
    items: [
      { to: '/super-admin', label: 'Clients (Tenants)', icon: Store, end: true },
    ],
  },
  {
    title: 'SaaS & Plans',
    items: [
      { to: '/super-admin?tab=plans', label: 'Subscription Plans', icon: Tag },
    ],
  },
  {
    title: 'Collections & Billing',
    items: [
      { to: '/super-admin?tab=invoices', label: 'Subscription Invoices', icon: FileText },
      { to: '/super-admin?tab=followups', label: 'Calling List & Follow-ups', icon: PhoneCall },
    ],
  },
];

export function SuperAdminLayout() {
  const { me, signOut, selectShop } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Security guard: must be platform admin
  if (!me?.user.isPlatformAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0d0f17] p-4 text-center">
        <div className="w-full max-w-md rounded-xl border border-red-900/40 bg-[#161926] p-8 text-white shadow-2xl">
          <Shield className="mx-auto size-12 text-red-400 mb-3" />
          <h1 className="text-xl font-bold">Access Restricted</h1>
          <p className="mt-2 text-sm text-slate-400">
            Platform Super Admin access is required to manage SaaS client tenants and subscriptions.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link
              to="/"
              className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Go to Store ERP
            </Link>
            <button
              onClick={() => void signOut()}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  const shops = me.memberships ?? [];

  const renderNavItems = () => (
    <nav className="flex-1 space-y-5 px-3 py-4 select-none">
      {SA_NAV.map((section, idx) => (
        <div key={idx} className="space-y-1">
          {section.title && (
            <div className="flex items-center justify-between px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              <span>{section.title}</span>
              <ChevronDown className="size-3 text-slate-500" />
            </div>
          )}
          {section.items.map((item) => {
            const Icon = item.icon;
            const isClientsTab = item.label === 'Clients (Tenants)' && !location.search.includes('tab=');
            const isTabActive =
              (item.to.includes('tab=plans') && location.search.includes('tab=plans')) ||
              (item.to.includes('tab=invoices') && location.search.includes('tab=invoices')) ||
              (item.to.includes('tab=followups') && location.search.includes('tab=followups'));
            const isActive = isClientsTab || isTabActive;

            return (
              <Link
                key={item.to + item.label}
                to={item.to}
                onClick={() => setMobileMenuOpen(false)}
                className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-[#221c16] text-[#f59e0b] border border-[#f59e0b]/30 shadow-sm'
                    : 'text-slate-300 hover:bg-[#1a1d2c] hover:text-white'
                }`}
              >
                <div className="flex items-center gap-3">
                  <Icon
                    className={`size-4.5 shrink-0 transition-colors ${
                      isActive ? 'text-[#f59e0b]' : 'text-slate-400 group-hover:text-slate-200'
                    }`}
                  />
                  <span>{item.label}</span>
                </div>
                {item.badge && (
                  <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0c13] text-slate-100 font-sans antialiased">
      {/* 1. DESKTOP SAAS SIDEBAR (Left) */}
      <aside className="hidden md:flex w-64 flex-col border-r border-[#1a1e2d] bg-[#111420] shrink-0">
        {/* Brand / Logo */}
        <div className="flex h-14 items-center justify-between border-b border-[#1a1e2d] px-5">
          <div className="flex items-center gap-2.5">
            <div className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-amber-500 to-amber-600 text-white font-bold text-xs shadow-md">
              <Shield className="size-4" />
            </div>
            <div>
              <span className="font-bold text-white text-base tracking-tight">SaaS Admin</span>
              <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400 border border-amber-500/20">
                PRO
              </span>
            </div>
          </div>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto">{renderNavItems()}</div>

        {/* Bottom Switcher: Exit back to client ERP store */}
        <div className="border-t border-[#1a1e2d] p-3 space-y-1">
          {shops.length > 0 && (
            <button
              onClick={() => {
                selectShop(shops[0]!.tenantId);
                navigate('/');
              }}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium text-slate-400 hover:bg-[#1a1d2c] hover:text-white transition-colors"
            >
              <div className="flex items-center gap-2 truncate">
                <Store className="size-3.5 text-slate-500 shrink-0" />
                <span className="truncate">Store: {shops[0]!.tenantName}</span>
              </div>
              <ChevronRight className="size-3 text-slate-500 shrink-0" />
            </button>
          )}

          <button
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-rose-400 hover:bg-rose-500/10 transition-colors"
          >
            <LogOut className="size-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {/* 2. MOBILE DRAWER (< 768px) */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 w-72 bg-[#111420] border-r border-[#1a1e2d] flex flex-col z-50">
            <div className="flex h-14 items-center justify-between border-b border-[#1a1e2d] px-4">
              <span className="font-bold text-white text-base">SaaS Admin</span>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="rounded p-1 text-slate-400 hover:text-white"
              >
                <X className="size-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{renderNavItems()}</div>
          </aside>
        </div>
      )}

      {/* 3. MAIN WORKSPACE AREA */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top Header Bar */}
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#1a1e2d] bg-[#111420] px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="inline-flex md:hidden rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <Menu className="size-5" />
            </button>
            {/* Breadcrumb matching user's reference */}
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span className="hover:text-slate-200">Tenants</span>
              <span>&gt;</span>
              <span className="text-slate-200 font-medium">List</span>
            </div>
          </div>

          {/* User Avatar & Dropdown */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2 rounded-full p-1 hover:ring-2 hover:ring-amber-500/50 transition-all"
            >
              <div className="flex size-8 items-center justify-center rounded-full bg-gradient-to-tr from-amber-600 to-amber-500 text-xs font-bold text-white shadow">
                SA
              </div>
            </button>

            {userMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setUserMenuOpen(false)}
                />
                <div className="absolute right-0 mt-2 w-56 rounded-xl border border-[#262b3d] bg-[#171a26] p-1.5 shadow-2xl z-50 text-xs">
                  <div className="px-3 py-2 border-b border-[#262b3d]">
                    <p className="font-semibold text-white">{me.user.fullName}</p>
                    <p className="text-slate-400 text-[11px] truncate">{me.user.email ?? me.user.phone}</p>
                    <span className="mt-1 inline-block rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
                      Platform Super Admin
                    </span>
                  </div>

                  {shops.length > 0 && (
                    <button
                      onClick={() => {
                        setUserMenuOpen(false);
                        selectShop(shops[0]!.tenantId);
                        navigate('/');
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-slate-300 hover:bg-[#202535] hover:text-white mt-1"
                    >
                      <Store className="size-3.5 text-slate-400" />
                      <span>Switch to Store ERP</span>
                    </button>
                  )}

                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      void signOut();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-rose-400 hover:bg-rose-500/10 mt-1"
                  >
                    <LogOut className="size-3.5" />
                    <span>Sign out</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        {/* Content View */}
        <main className="flex-1 overflow-y-auto bg-[#0a0c13] p-4 sm:p-6 lg:p-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
