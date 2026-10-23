import { useQuery } from '@tanstack/react-query';
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { Branch, Reference } from '../api/types';
import { useAuth } from './auth';

/*
 * Data almost every screen needs: the shop's branches (and which one the user
 * is working in) and the reference lists (units, states).
 */

export function useReference() {
  return useQuery({
    queryKey: ['reference'],
    queryFn: () => api<Reference>('/v1/reference', { noTenant: true }),
    staleTime: Infinity,
  });
}

export function useBranches() {
  const { tenantId } = useAuth();
  return useQuery({
    queryKey: ['branches', tenantId],
    queryFn: () => api<{ items: Branch[] }>('/v1/branches').then((r) => r.items),
    enabled: !!tenantId,
    staleTime: 5 * 60_000,
  });
}

interface BranchContextValue {
  branch: Branch | null;
  branches: Branch[];
  setBranchId(id: string): void;
}

const BranchContext = createContext<BranchContextValue>({
  branch: null,
  branches: [],
  setBranchId: () => {},
});
const storageKey = (tenantId: string) => `glass-erp.branch.${tenantId}`;

/** One shared "current branch" for the whole app, remembered per shop. */
export function BranchProvider({ children }: { children: ReactNode }) {
  const { tenantId } = useAuth();
  const { data } = useBranches();
  const [branchId, setBranchId] = useState<string | null>(null);

  useEffect(() => {
    setBranchId(tenantId ? localStorage.getItem(storageKey(tenantId)) : null);
  }, [tenantId]);

  const value = useMemo<BranchContextValue>(() => {
    const branches = data?.filter((b) => b.isActive) ?? [];
    const branch = branches.find((b) => b.id === branchId) ?? branches[0] ?? null;
    return {
      branch,
      branches,
      setBranchId(id) {
        if (tenantId) localStorage.setItem(storageKey(tenantId), id);
        setBranchId(id);
      },
    };
  }, [data, branchId, tenantId]);

  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>;
}

export const useCurrentBranch = () => useContext(BranchContext);

export function useStateName() {
  const { data } = useReference();
  return (code: string | null | undefined) =>
    code ? `${data?.states.find((s) => s.code === code)?.name ?? code} (${code})` : '';
}
