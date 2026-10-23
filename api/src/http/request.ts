import type { FastifyRequest } from 'fastify';
import type { Role } from '../auth/roles.js';
import type { DbClient } from '../db/transaction.js';
import { AppError } from './errors.js';

/** Set by the auth guards (see auth/guards.ts). */
export interface AuthContext {
  userId: string;
  sessionId: string;
  /** Shop selected with the X-Tenant-Id header, if any (membership verified). */
  tenantId: string | null;
  role: Role | null;
  /** Branches this member may work in; null = all branches. */
  branchIds: string[] | null;
}

export interface TenantAuthContext extends AuthContext {
  tenantId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** Runs `work` in one transaction as this request's user and shop. See db/transaction.ts. */
    tx<T>(work: (client: DbClient) => Promise<T>): Promise<T>;
  }
}

/** For routes behind guards.user(): the signed-in user. */
export function userOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
  return request.auth;
}

/** For routes behind guards.tenant(...): the signed-in user inside a shop. */
export function tenantOf(request: FastifyRequest): TenantAuthContext {
  const auth = userOf(request);
  if (!auth.tenantId || !auth.role) {
    throw new AppError(400, 'TENANT_REQUIRED', 'Select a shop with the X-Tenant-Id header');
  }
  return auth as TenantAuthContext;
}

/** Members limited to some branches can only create documents in those. */
export function assertBranchAccess(auth: AuthContext, branchId: string): void {
  if (auth.branchIds && !auth.branchIds.includes(branchId)) {
    throw new AppError(403, 'FORBIDDEN', 'You do not have access to this branch');
  }
}
