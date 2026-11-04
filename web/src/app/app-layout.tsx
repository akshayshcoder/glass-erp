import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Boxes,
  Building2,
  Calendar,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileCheck2,
  FilePlus2,
  FileText,
  Landmark,
  LayoutDashboard,
  Lock,
  LogOut,
  Menu,
  Package,
  PackagePlus,
  Shield,
  Store,
  Undo2,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '../components/ui';
import { currentFiscalYear } from '../lib/fiscal-year';
import { can, useAuth } from './auth';
import { BranchProvider, useCurrentBranch } from './shop-data';

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  /** Only shown to roles with this permission. */
  needs?: keyof typeof can;
}

const NAV: { section?: string; items: NavItem[] }[] = [
  { items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true }] },
  {
    section: 'Sales',
    items: [
      { to: '/invoices/new', label: 'New bill', icon: FilePlus2, needs: 'sell' },
      { to: '/invoices', label: 'Invoices', icon: FileText, end: true },
      { to: '/quotations', label: 'Quotations', icon: FileCheck2 },
      { to: '/receipts', label: 'Receipts', icon: ArrowDownLeft },
      { to: '/credit-notes', label: 'Credit notes', icon: Undo2 },
    ],
  },
  {
    section: 'Purchases',
    items: [
      { to: '/purchases', label: 'Purchase bills', icon: PackagePlus },
      { to: '/supplier-payments', label: 'Supplier payments', icon: ArrowUpRight },
    ],
  },
  {
    section: 'Inventory',
    items: [
      { to: '/products', label: 'Products', icon: Package },
      { to: '/stock', label: 'Stock', icon: Boxes },
      { to: '/parties', label: 'Customers & suppliers', icon: Users },
    ],
  },
  {
    section: 'Reports',
    items: [
      { to: '/reports/gst', label: 'GSTR-1', icon: Landmark, needs: 'reports' },
      { to: '/reports/sales', label: 'Sales', icon: BarChart3, needs: 'reports' },
      { to: '/reports/dues', label: 'Dues', icon: Clock, needs: 'reports' },
      { to: '/reports/stock', label: 'Stock value', icon: Boxes, needs: 'reports' },
      { to: '/reports/purchases', label: 'Purchase register', icon: FileText, needs: 'reports' },
    ],
  },
  {
    section: 'Settings',
    items: [
      { to: '/settings/team', label: 'Team', icon: UserCog, needs: 'viewTeam' },
      { to: '/settings/branches', label: 'Branches', icon: Building2 },
      { to: '/settings/gst', label: 'GST month lock', icon: Lock },
    ],
  },
];

/** Signed in? Otherwise to /login, coming back here afterwards. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner />;
  if (status === 'signedOut')
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** A shop selected? Otherwise to /shops. */
export function RequireShop() {
  const { tenantId } = useAuth();
  if (!tenantId) return <Navigate to="/shops" replace />;
  return (
    <BranchProvider>
      <AppLayout />
    </BranchProvider>
  );
}

function AppLayout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [tabletCollapsed, setTabletCollapsed] = useState(false);
  const location = useLocation();
  const { role, me } = useAuth();

  // Close mobile drawer on route change
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Lock body scroll when mobile drawer is open
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  const allowed = (item: NavItem) =>
    !item.needs || (!!role && (can[item.needs] as string[]).includes(role));

  const renderNav = (isCompact = false) => (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3 sm:px-3" aria-label="Main">
      {NAV.map(({ section, items }) => {
        const visibleItems = items.filter(allowed);
        if (!visibleItems.length) return null;
        return (
          <div key={section ?? 'home'} className="mb-2">
            {section && !isCompact && (
              <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
                {section}
              </p>
            )}
            {section && isCompact && (
              <div className="my-2 border-t border-slate-800" title={section} />
            )}
            {visibleItems.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                title={isCompact ? label : undefined}
                onClick={() => setDrawerOpen(false)}
                className={({ isActive }) =>
                  `group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors ${
                    isCompact ? 'justify-center px-2' : 'px-3'
                  } ${
                    isActive
                      ? 'bg-brand-600 text-white shadow-xs'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`
                }
              >
                <Icon className="size-4.5 shrink-0" aria-hidden />
                {!isCompact && <span className="truncate">{label}</span>}
              </NavLink>
            ))}
          </div>
        );
      })}
      {me?.user.isPlatformAdmin && (
        <div className="mb-2 pt-2 border-t border-slate-800">
          {!isCompact && (
            <p className="px-3 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-purple-400 uppercase">
              Platform
            </p>
          )}
          <NavLink
            to="/super-admin"
            title={isCompact ? 'Super Admin' : undefined}
            onClick={() => setDrawerOpen(false)}
            className={({ isActive }) =>
              `group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors ${
                isCompact ? 'justify-center px-2' : 'px-3'
              } ${
                isActive
                  ? 'bg-purple-600 text-white shadow-xs'
                  : 'text-purple-300 hover:bg-slate-800 hover:text-white'
              }`
            }
          >
            <Shield className="size-4.5 shrink-0 text-purple-400" aria-hidden />
            {!isCompact && <span className="truncate">Super Admin</span>}
          </NavLink>
        </div>
      )}
    </nav>
  );

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-50">
      {/* 1. DESKTOP & TABLET SIDEBAR (Hidden on mobile < 768px, shown on md:) */}
      <aside
        className={`hidden md:flex flex-col bg-slate-900 border-r border-slate-800 transition-all duration-200 shrink-0 select-none ${
          tabletCollapsed ? 'w-18' : 'w-60 lg:w-64'
        }`}
      >
        <div className="flex h-14 items-center justify-between px-4 border-b border-slate-800">
          <Link
            to="/"
            className={`font-semibold tracking-tight text-white flex items-center gap-2 ${
              tabletCollapsed ? 'justify-center w-full text-base' : 'text-lg'
            }`}
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-brand-600 font-bold text-white text-xs">
              G
            </span>
            {!tabletCollapsed && <span>Glass ERP</span>}
          </Link>
          <button
            type="button"
            onClick={() => setTabletCollapsed(!tabletCollapsed)}
            className="hidden md:inline-flex lg:hidden rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            title={tabletCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={tabletCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {tabletCollapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
          </button>
        </div>
        {renderNav(tabletCollapsed)}
      </aside>

      {/* 2. MOBILE OVERLAY DRAWER (< 768px) */}
      <div
        className={`fixed inset-0 z-50 md:hidden transition-visibility duration-300 ${
          drawerOpen ? 'visible pointer-events-auto' : 'invisible pointer-events-none'
        }`}
      >
        {/* Backdrop */}
        <div
          className={`fixed inset-0 bg-slate-950/60 backdrop-blur-xs transition-opacity duration-300 ${
            drawerOpen ? 'opacity-100' : 'opacity-0'
          }`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />

        {/* Drawer slide-over */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-slate-900 shadow-2xl transition-transform duration-300 ease-out ${
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation"
        >
          <div className="flex h-14 items-center justify-between border-b border-slate-800 px-4">
            <Link to="/" onClick={() => setDrawerOpen(false)} className="flex items-center gap-2 text-lg font-semibold text-white">
              <span className="flex size-7 items-center justify-center rounded-md bg-brand-600 font-bold text-white text-xs">
                G
              </span>
              <span>Glass ERP</span>
            </Link>
            <button
              type="button"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
            >
              <X className="size-5" />
            </button>
          </div>
          {renderNav(false)}
        </aside>
      </div>

      {/* 3. MAIN CONTENT CONTAINER */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar onMenu={() => setDrawerOpen(true)} />
        <main className="flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6 lg:px-8">
          <div className="mx-auto max-w-7xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const { me, shopName, signOut } = useAuth();
  const { branch, branches, setBranchId } = useCurrentBranch();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 sm:gap-3 border-b border-slate-200 bg-white px-3 sm:px-6 lg:px-8">
      {/* Mobile Drawer Trigger (< 768px) */}
      <button
        type="button"
        className="inline-flex md:hidden rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        onClick={onMenu}
        aria-label="Open menu"
      >
        <Menu className="size-5" />
      </button>

      {/* Shop Selector */}
      <Link
        to="/shops"
        className="flex min-w-0 items-center gap-1.5 text-xs sm:text-sm font-semibold text-slate-900 hover:text-brand-700"
        title="Switch shop"
      >
        <Store className="size-4 shrink-0 text-slate-400" aria-hidden />
        <span className="truncate max-w-[110px] sm:max-w-[200px]">{shopName}</span>
      </Link>

      {/* Branch Selector */}
      {branches.length > 1 ? (
        <select
          aria-label="Branch"
          value={branch?.id ?? ''}
          onChange={(e) => setBranchId(e.target.value)}
          className="max-w-[100px] sm:max-w-[160px] truncate rounded-md border-0 bg-slate-100 py-1 pr-6 pl-2 text-xs sm:text-sm text-slate-700 focus:ring-2 focus:ring-brand-600"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      ) : (
        branch && <span className="hidden sm:inline text-xs sm:text-sm text-slate-500 truncate max-w-[120px]">· {branch.name}</span>
      )}

      {/* Financial Year Badge */}
      <span
        className="hidden md:inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200"
        title="Active Financial Year"
      >
        <Calendar className="size-3 text-slate-400" />
        FY {currentFiscalYear()}
      </span>

      {/* User profile & actions */}
      <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
        {me?.user.isPlatformAdmin && (
          <Link
            to="/super-admin"
            className="inline-flex items-center gap-1 rounded-md bg-purple-50 px-2 py-1 text-xs font-medium text-purple-700 ring-1 ring-purple-600/20 hover:bg-purple-100"
            title="Open Super Admin Portal"
          >
            <Shield className="size-3.5" />
            <span className="hidden sm:inline">Super Admin</span>
          </Link>
        )}
        <span className="hidden md:inline text-xs sm:text-sm font-medium text-slate-700 truncate max-w-[150px]">
          {me?.user.fullName}
        </span>
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-xs sm:text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900"
          title="Sign out"
        >
          <LogOut className="size-4" aria-hidden />
          <span className="hidden sm:inline">Sign out</span>
        </button>
      </div>
    </header>
  );
}
