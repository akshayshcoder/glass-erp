import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { queryOne } from '../db/sql.js';
import { withTransaction } from '../db/transaction.js';
import { AppError, forbidden } from '../http/errors.js';
import { tenantOf } from '../http/request.js';
import { Uuid } from '../http/validation.js';
import type { Role } from './roles.js';
import type { TokenService } from './tokens.js';

/**
 * One query per request checks, together:
 *   - the user still exists and is active,
 *   - the login session was not logged out / revoked,
 *   - (if a shop is selected) the user is an active member of an active shop.
 * So logout, disabling a user or removing them from a shop works immediately,
 * not only when their access token expires.
 */
const SESSION_SQL = `
  SELECT m.role, m.branch_ids
  FROM erp.users u
  JOIN erp.user_sessions s
    ON s.user_id = u.id AND s.family_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
  LEFT JOIN (erp.tenant_members m JOIN erp.tenants t ON t.id = m.tenant_id AND t.status = 'active')
    ON m.user_id = u.id AND m.tenant_id = $3::uuid AND m.status = 'active'
  WHERE u.id = $1 AND u.status = 'active'
  LIMIT 1`;

export type Guard = (request: FastifyRequest) => Promise<void>;

export interface Guards {
  /** Signed in; a shop is optional. */
  user: Guard;
  /** Signed in, a shop selected, and the user's role in it is one of `roles`. */
  tenant(roles: readonly Role[]): Guard;
}

export function createGuards(pool: pg.Pool, tokens: TokenService): Guards {
  async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
    }
    const claims = await tokens.verifyAccessToken(header.slice('Bearer '.length));

    const tenantHeader = request.headers['x-tenant-id'];
    let tenantId: string | null = null;
    if (typeof tenantHeader === 'string' && tenantHeader !== '') {
      const parsed = Uuid.safeParse(tenantHeader);
      if (!parsed.success)
        throw new AppError(400, 'VALIDATION_FAILED', 'X-Tenant-Id must be a UUID');
      tenantId = parsed.data;
    }

    const row = await withTransaction(
      pool,
      { requestId: request.id, userId: claims.userId, clientIp: request.ip },
      (client) =>
        queryOne<{ role: Role | null; branch_ids: string[] | null }>(client, SESSION_SQL, [
          claims.userId,
          claims.sessionId,
          tenantId,
        ]),
    );
    if (!row) {
      throw new AppError(401, 'SESSION_REVOKED', 'Your session has ended. Please sign in again.');
    }
    if (tenantId && !row.role) {
      throw new AppError(403, 'NOT_A_MEMBER', 'You are not a member of this shop');
    }
    request.auth = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      tenantId: row.role ? tenantId : null,
      role: row.role,
      branchIds: row.branch_ids,
    };
  }

  return {
    user: authenticate,
    tenant(roles) {
      return async (request) => {
        await authenticate(request);
        const { role } = tenantOf(request);
        if (!roles.includes(role)) throw forbidden();
      };
    },
  };
}
