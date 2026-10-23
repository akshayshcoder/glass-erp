import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, session } from '../api/client';
import type { Me, Role } from '../api/types';

/*
 * Who is signed in, and which shop they are working in.
 *
 *   status    loading -> signedIn | signedOut
 *   me        the user and their shops (memberships)
 *   tenantId  the selected shop (remembered across reloads)
 */

interface AuthContextValue {
  status: 'loading' | 'signedIn' | 'signedOut';
  me: Me | null;
  tenantId: string | null;
  role: Role | null;
  shopName: string | null;
  signIn(login: string, password: string): Promise<void>;
  register(input: {
    fullName: string;
    phone?: string;
    email?: string;
    password: string;
  }): Promise<void>;
  signOut(): Promise<void>;
  selectShop(tenantId: string | null): void;
  reloadMe(): Promise<Me>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthContextValue['status']>(
    session.hasSession() ? 'loading' : 'signedOut',
  );
  const [me, setMe] = useState<Me | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(session.tenantId());

  const reloadMe = useCallback(async () => {
    const fresh = await api<Me>('/v1/me', { noTenant: true });
    setMe(fresh);
    setStatus('signedIn');
    // Forget a remembered shop the user no longer belongs to; pick the only one automatically.
    const current = session.tenantId();
    if (current && !fresh.memberships.some((m) => m.tenantId === current))
      session.setTenantId(null);
    if (!session.tenantId() && fresh.memberships.length === 1)
      session.setTenantId(fresh.memberships[0]!.tenantId);
    return fresh;
  }, []);

  useEffect(() => {
    if (session.hasSession()) reloadMe().catch(() => setStatus('signedOut'));
    return session.subscribe(() => {
      setTenantId(session.tenantId());
      if (!session.hasSession()) {
        setMe(null);
        setStatus('signedOut');
      }
    });
  }, [reloadMe]);

  const value = useMemo<AuthContextValue>(() => {
    const membership = me?.memberships.find((m) => m.tenantId === tenantId) ?? null;
    return {
      status,
      me,
      tenantId: membership ? tenantId : null,
      role: membership?.role ?? null,
      shopName: membership?.tenantName ?? null,
      async signIn(login, password) {
        session.store(
          await api('/v1/auth/login', {
            method: 'POST',
            body: { login, password },
            noTenant: true,
          }),
        );
        await reloadMe();
      },
      async register(input) {
        await api('/v1/auth/register', { method: 'POST', body: input, noTenant: true });
        const login = input.phone ?? input.email!;
        session.store(
          await api('/v1/auth/login', {
            method: 'POST',
            body: { login, password: input.password },
            noTenant: true,
          }),
        );
        await reloadMe();
      },
      async signOut() {
        await api('/v1/auth/logout', { method: 'POST', noTenant: true }).catch(() => {});
        session.clear();
        queryClient.clear();
      },
      selectShop(id) {
        queryClient.clear(); // never show one shop's cached data in another
        session.setTenantId(id);
      },
      reloadMe,
    };
  }, [status, me, tenantId, reloadMe, queryClient]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Same permission groups as the API (api/src/auth/roles.ts), for hiding buttons. */
export const can = {
  sell: ['owner', 'admin', 'manager', 'billing'],
  cancelSales: ['owner', 'admin', 'manager'],
  manageProducts: ['owner', 'admin', 'manager', 'storekeeper'],
  manageParties: ['owner', 'admin', 'manager', 'billing'],
  adjustStock: ['owner', 'admin', 'manager', 'storekeeper'],
  postOpeningBalance: ['owner', 'admin'],
  purchase: ['owner', 'admin', 'manager', 'storekeeper'],
  cancelPurchase: ['owner', 'admin', 'manager'],
  paySuppliers: ['owner', 'admin', 'manager'],
  creditNotes: ['owner', 'admin', 'manager'],
  quote: ['owner', 'admin', 'manager', 'billing'],
  viewTeam: ['owner', 'admin', 'manager'],
  manageTeam: ['owner', 'admin'],
  manageShop: ['owner'],
  lockGstPeriod: ['owner', 'admin', 'accountant'],
  unlockGstPeriod: ['owner', 'admin'],
  reports: ['owner', 'admin', 'manager', 'accountant'],
} satisfies Record<string, Role[]>;

export function useCan(permission: keyof typeof can): boolean {
  const { role } = useAuth();
  return !!role && (can[permission] as Role[]).includes(role);
}
