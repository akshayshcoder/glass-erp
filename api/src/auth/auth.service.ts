import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { query, queryOne } from '../db/sql.js';
import { type DbClient, type RequestContext, withTransaction } from '../db/transaction.js';
import { AppError } from '../http/errors.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';
import { hashPassword, simulatePasswordCheck, verifyPassword } from './passwords.js';
import { type TokenService, generateRefreshToken, hashRefreshToken } from './tokens.js';

/** Failed logins before the account is locked, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
/**
 * Two browser tabs may refresh with the same token at the same moment. The
 * loser of that race should just get 401, not trigger theft protection, so a
 * token rotated within this window is not treated as "reused".
 */
const ROTATION_GRACE_SECONDS = 10;

export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export interface UserProfile {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
}

const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect phone/email or password');

export class AuthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly tokens: TokenService,
    private readonly refreshTokenTtlDays: number,
  ) {}

  async register(ctx: RequestContext, input: RegisterInput): Promise<UserProfile> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await withTransaction(this.pool, ctx, async (c) => {
        const row = await queryOne<UserRow>(
          c,
          `INSERT INTO erp.users (full_name, email, phone, password_hash)
           VALUES ($1, $2, $3, $4)
           RETURNING id, full_name, email, phone`,
          [input.fullName, input.email ?? null, input.phone ?? null, passwordHash],
        );
        return toProfile(row!);
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'DUPLICATE', 'An account with this email or phone already exists');
      }
      throw err;
    }
  }

  async login(ctx: RequestContext, input: LoginInput, userAgent?: string): Promise<TokenPair> {
    const user = await withTransaction(this.pool, ctx, (c) =>
      queryOne<{ id: string; password_hash: string | null; status: string; locked: boolean }>(
        c,
        `SELECT id, password_hash, status, coalesce(locked_until > now(), false) AS locked
         FROM erp.users
         WHERE CASE WHEN $1 LIKE '%@%' THEN lower(email) = lower($1) ELSE phone = $1 END`,
        [input.login.trim()],
      ),
    );

    if (!user || !user.password_hash || user.status !== 'active') {
      await simulatePasswordCheck(input.password);
      await this.logEvent(ctx, user?.id ?? null, 'auth.login_failed', {
        login: input.login,
        reason: user ? 'inactive' : 'unknown_user',
      });
      throw invalidCredentials();
    }
    if (user.locked) {
      await this.logEvent(ctx, user.id, 'auth.login_failed', { reason: 'locked' });
      throw new AppError(
        423,
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Try again in ${LOCK_MINUTES} minutes.`,
      );
    }

    if (!(await verifyPassword(user.password_hash, input.password))) {
      // Committed on its own (we are about to throw). The counter is updated
      // atomically in SQL, so parallel guessing can't lose increments.
      await withTransaction(this.pool, { ...ctx, userId: user.id }, async (c) => {
        await c.query(
          `UPDATE erp.users SET
             failed_login_count = CASE WHEN locked_until <= now() THEN 1 ELSE failed_login_count + 1 END,
             locked_until = CASE
               WHEN (CASE WHEN locked_until <= now() THEN 1 ELSE failed_login_count + 1 END) >= $2
                 THEN now() + make_interval(mins => $3)
               WHEN locked_until <= now() THEN NULL
               ELSE locked_until END
           WHERE id = $1`,
          [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
        );
        await logEventIn(c, 'auth.login_failed', user.id, { reason: 'wrong_password' });
      });
      throw invalidCredentials();
    }

    const familyId = randomUUID();
    const refreshToken = generateRefreshToken();
    await withTransaction(this.pool, { ...ctx, userId: user.id }, async (c) => {
      await c.query(
        `UPDATE erp.users SET failed_login_count = 0, locked_until = NULL, last_login_at = now()
         WHERE id = $1`,
        [user.id],
      );
      await this.insertSession(c, ctx, user.id, familyId, refreshToken, userAgent);
      await logEventIn(c, 'auth.login', user.id, { userAgent: userAgent ?? null });
    });
    return this.issue(user.id, familyId, refreshToken);
  }

  /** Exchanges a refresh token for a new pair. The old refresh token stops working. */
  async refresh(ctx: RequestContext, refreshToken: string, userAgent?: string): Promise<TokenPair> {
    const hash = hashRefreshToken(refreshToken);
    const next = generateRefreshToken();

    const rotated = await withTransaction(this.pool, ctx, async (c) => {
      // Atomic: of two concurrent refreshes with the same token, exactly one
      // gets a row back.
      const row = await queryOne<{ user_id: string; family_id: string }>(
        c,
        `UPDATE erp.user_sessions s
            SET revoked_at = now(), revoked_reason = 'rotated'
           FROM erp.users u
          WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
            AND u.id = s.user_id AND u.status = 'active'
         RETURNING s.user_id, s.family_id`,
        [hash],
      );
      if (row) {
        await this.insertSession(c, ctx, row.user_id, row.family_id, next, userAgent);
        return row;
      }

      // Not usable. If it was rotated a while ago, someone is replaying an old
      // (stolen) token: end that login everywhere.
      const old = await queryOne<{ user_id: string; family_id: string; reused: boolean }>(
        c,
        `SELECT user_id, family_id,
                revoked_reason = 'rotated' AND revoked_at < now() - make_interval(secs => $2) AS reused
         FROM erp.user_sessions WHERE refresh_token_hash = $1`,
        [hash, ROTATION_GRACE_SECONDS],
      );
      if (old?.reused) {
        await c.query(
          `UPDATE erp.user_sessions SET revoked_at = now(), revoked_reason = 'reuse_detected'
           WHERE family_id = $1 AND revoked_at IS NULL`,
          [old.family_id],
        );
        await c.query(`SELECT set_config('app.user_id', $1, true)`, [old.user_id]);
        await logEventIn(c, 'auth.refresh_token_reused', old.user_id, { familyId: old.family_id });
      }
      return null;
    });

    if (!rotated) {
      throw new AppError(401, 'SESSION_REVOKED', 'Your session has ended. Please sign in again.');
    }
    return this.issue(rotated.user_id, rotated.family_id, next);
  }

  async logout(ctx: RequestContext, sessionId: string): Promise<void> {
    await withTransaction(this.pool, ctx, async (c) => {
      await c.query(
        `UPDATE erp.user_sessions SET revoked_at = now(), revoked_reason = 'logout'
         WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [sessionId, ctx.userId],
      );
      await logEventIn(c, 'auth.logout', ctx.userId!, {});
    });
  }

  async me(ctx: RequestContext) {
    return withTransaction(this.pool, ctx, async (c) => {
      const user = await queryOne<UserRow>(
        c,
        'SELECT id, full_name, email, phone FROM erp.users WHERE id = $1',
        [ctx.userId],
      );
      const memberships = await query<{ tenant_id: string; name: string; role: string }>(
        c,
        `SELECT m.tenant_id, t.name, m.role
         FROM erp.tenant_members m JOIN erp.tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.status = 'active' AND t.status = 'active'
         ORDER BY t.name`,
        [ctx.userId],
      );
      return {
        user: toProfile(user!),
        memberships: memberships.map((m) => ({
          tenantId: m.tenant_id,
          tenantName: m.name,
          role: m.role,
        })),
      };
    });
  }

  private async insertSession(
    c: DbClient,
    ctx: RequestContext,
    userId: string,
    familyId: string,
    refreshToken: string,
    userAgent?: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO erp.user_sessions
         (family_id, user_id, refresh_token_hash, expires_at, user_agent, client_ip)
       VALUES ($1, $2, $3, now() + make_interval(days => $4), $5, $6)`,
      [
        familyId,
        userId,
        hashRefreshToken(refreshToken),
        this.refreshTokenTtlDays,
        userAgent ?? null,
        ctx.clientIp ?? null,
      ],
    );
  }

  private async issue(userId: string, sessionId: string, refreshToken: string): Promise<TokenPair> {
    return {
      tokenType: 'Bearer',
      accessToken: await this.tokens.createAccessToken({ userId, sessionId }),
      expiresIn: this.tokens.accessTokenTtlSeconds,
      refreshToken,
    };
  }

  private logEvent(ctx: RequestContext, userId: string | null, type: string, details: object) {
    return withTransaction(this.pool, { ...ctx, userId }, (c) =>
      logEventIn(c, type, userId, details),
    );
  }
}

interface UserRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
}

function toProfile(row: UserRow): UserProfile {
  return { id: row.id, fullName: row.full_name, email: row.email, phone: row.phone };
}

async function logEventIn(c: DbClient, type: string, userId: string | null, details: object) {
  await c.query(`SELECT audit.log_event($1, 'user', $2, $3)`, [
    type,
    userId,
    JSON.stringify(details),
  ]);
}
