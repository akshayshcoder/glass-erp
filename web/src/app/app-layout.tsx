import {
  ArrowDownLeft,
  ArrowUpRight,
  BarChart3,
  Boxes,
  Building2,
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
  Store,
  Undo2,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from '../components/ui';
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
  const [menuOpen, setMenuOpen] = useState(false);
  const { role } = useAuth();
  const allowed = (item: NavItem) =>
    !item.needs || (!!role && (can[item.needs] as string[]).includes(role));

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3" aria-label="Main">
      {NAV.map(({ section, items }) => (
        <div key={section ?? 'home'} className="mb-2">
          {section && (
            <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wide text-slate-500 uppercase">
              {section}
            </p>
          )}
          {items.filter(allowed).map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMenuOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-1.5 text-sm font-medium ${
                  isActive
                    ? 'bg-brand-700 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`
              }
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex h-full">
      {/* Sidebar: fixed on desktop, slide-over on small screens */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-slate-900 transition-transform lg:static lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center justify-between px-5">
          <Link to="/" className="text-lg font-semibold text-white">
            Glass ERP
          </Link>
          <button
            className="text-slate-400 lg:hidden"
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          >
            <X className="size-5" />
          </button>
        </div>
        {nav}
      </aside>
      {menuOpen && (
        <div
          className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onMenu={() => setMenuOpen(true)} />
        <main className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
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
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-8">
      <button className="text-slate-500 lg:hidden" onClick={onMenu} aria-label="Open menu">
        <Menu className="size-5" />
      </button>
      <Link
        to="/shops"
        className="flex items-center gap-2 text-sm font-semibold text-slate-900 hover:text-brand-700"
        title="Switch shop"
      >
        <Store className="size-4 text-slate-400" aria-hidden />
        {shopName}
      </Link>
      {branches.length > 1 ? (
        <select
          aria-label="Branch"
          value={branch?.id ?? ''}
          onChange={(e) => setBranchId(e.target.value)}
          className="rounded-md border-0 bg-slate-100 py-1 pr-7 pl-2 text-sm text-slate-700"
        >
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      ) : (
        branch && <span className="text-sm text-slate-500">· {branch.name}</span>
      )}
      <div className="ml-auto flex items-center gap-3">
        <span className="hidden text-sm text-slate-600 sm:inline">{me?.user.fullName}</span>
        <button
          onClick={() => void signOut()}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-900"
        >
          <LogOut className="size-4" aria-hidden />
          Sign out
        </button>
      </div>
    </header>
  );
}
