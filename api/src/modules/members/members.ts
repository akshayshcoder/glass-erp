import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { hashPassword } from '../../auth/passwords.js';
import { Permissions, ROLES, type Role } from '../../auth/roles.js';
import { type DbClient } from '../../db/transaction.js';
import { query, queryOne, updateVersioned } from '../../db/sql.js';
import { AppError, forbidden, notFound } from '../../http/errors.js';
import { tenantOf } from '../../http/request.js';
import { Email, IdParams, NonEmpty, Phone, Uuid, Version } from '../../http/validation.js';

/**
 * Team members of the current shop.
 *
 *   GET   /v1/members        list
 *   POST  /v1/members        create or link a user and add them with a role
 *   PATCH /v1/members/:id    change role / branches / password / disable
 *
 * Rules: only an owner can grant or change the owner role, and a shop always
 * keeps at least one active owner (checked under a lock, so two owners
 * demoting each other at the same moment can't leave the shop ownerless).
 */

const Role = z.enum(ROLES);
const MemberPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'At most 128 characters');

const AddMemberBody = z.object({
  /** Email or phone for the member to sign in with. */
  login: NonEmpty,
  /** Required when creating a new user account directly. */
  fullName: NonEmpty.optional(),
  /** Required when creating a new user account directly. */
  password: MemberPassword.optional(),
  role: Role,
  branchIds: z.array(Uuid).nullable().optional(),
});

const UpdateMemberBody = z.object({
  version: Version,
  fullName: NonEmpty.optional(),
  password: MemberPassword.optional(),
  role: Role.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  branchIds: z.array(Uuid).nullable().optional(),
});

interface MemberRow {
  id: string;
  user_id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  branch_ids: string[] | null;
  status: string;
  version: number;
}

const toMember = (r: MemberRow) => ({
  id: r.id,
  userId: r.user_id,
  fullName: r.full_name,
  email: r.email,
  phone: r.phone,
  role: r.role,
  branchIds: r.branch_ids,
  status: r.status,
  version: r.version,
});

// NOTE: tenant_members is also visible for the user's OTHER shops (shop
// switcher), so every query here filters on the current tenant explicitly.
const MEMBER_SELECT = `
  SELECT m.id, m.user_id, u.full_name, u.email, u.phone, m.role, m.branch_ids, m.status, m.version
  FROM erp.tenant_members m JOIN erp.users u ON u.id = m.user_id
  WHERE m.tenant_id = erp.current_tenant_id()`;

async function getMember(c: DbClient, id: string): Promise<MemberRow> {
  const row = await queryOne<MemberRow>(c, `${MEMBER_SELECT} AND m.id = $1`, [id]);
  if (!row) throw notFound('Member');
  return row;
}

export function registerMemberRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/members', { preHandler: guards.tenant(Permissions.viewTeam) }, async (request) => {
    const rows = await request.tx((c) =>
      query<MemberRow>(c, `${MEMBER_SELECT} ORDER BY u.full_name`),
    );
    return { items: rows.map(toMember) };
  });

  app.post(
    '/members',
    { preHandler: guards.tenant(Permissions.manageTeam) },
    async (request, reply) => {
      const actor = tenantOf(request);
      const body = AddMemberBody.parse(request.body);
      if (body.role === 'owner' && actor.role !== 'owner')
        throw forbidden('Only an owner can add another owner');

      const loginRaw = body.login.trim();
      const isEmail = loginRaw.includes('@');
      const email = isEmail ? Email.parse(loginRaw) : null;
      const phone = !isEmail ? Phone.parse(loginRaw) : null;
      const passwordHash = body.password ? await hashPassword(body.password) : null;

      const member = await request.tx(async (c) => {
        let user = await queryOne<{ id: string }>(
          c,
          `SELECT id FROM erp.users
           WHERE CASE WHEN $1 LIKE '%@%' THEN lower(email) = lower($1) ELSE phone = $1 END`,
          [loginRaw],
        );

        if (!user) {
          if (!body.fullName || !passwordHash) {
            throw new AppError(
              422,
              'VALIDATION_FAILED',
              'Full name and password (min 8 characters) are required to create a new team member.',
            );
          }
          user = await queryOne<{ id: string }>(
            c,
            `INSERT INTO erp.users (full_name, email, phone, password_hash)
             VALUES ($1, $2, $3, $4)
             RETURNING id`,
            [body.fullName, email, phone, passwordHash],
          );
        } else if (passwordHash || body.fullName) {
          await c.query(
            `UPDATE erp.users
                SET full_name = coalesce($2, full_name),
                    password_hash = coalesce($3, password_hash)
              WHERE id = $1`,
            [user.id, body.fullName ?? null, passwordHash],
          );
        }

        try {
          const { id } = (await queryOne<{ id: string }>(
            c,
            `INSERT INTO erp.tenant_members (user_id, role, branch_ids) VALUES ($1, $2, $3) RETURNING id`,
            [user!.id, body.role, body.branchIds ?? null],
          ))!;
          return getMember(c, id);
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new AppError(409, 'DUPLICATE', 'This person is already a member of the shop');
          }
          throw err;
        }
      });
      return reply.status(201).send(toMember(member));
    },
  );

  app.patch(
    '/members/:id',
    { preHandler: guards.tenant(Permissions.manageTeam) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const { version, fullName, password, ...changes } = UpdateMemberBody.parse(request.body);
      const passwordHash = password ? await hashPassword(password) : null;

      const member = await request.tx(async (c) => {
        // Lock all active owner rows first (fixed order: no deadlocks), then decide.
        const owners = await query<{ id: string }>(
          c,
          `SELECT id FROM erp.tenant_members
         WHERE tenant_id = erp.current_tenant_id() AND role = 'owner' AND status = 'active'
         ORDER BY id FOR NO KEY UPDATE`,
        );
        // Re-read the actor's own role AFTER the lock: they may have been demoted
        // a moment ago by a request that won the lock first.
        const actor = await queryOne<{ role: Role }>(
          c,
          `SELECT role FROM erp.tenant_members
         WHERE tenant_id = erp.current_tenant_id() AND user_id = erp.current_user_id() AND status = 'active'`,
        );
        if (!actor || !(Permissions.manageTeam as readonly Role[]).includes(actor.role))
          throw forbidden();
        const target = await getMember(c, id);

        if ((target.role === 'owner' || changes.role === 'owner') && actor.role !== 'owner') {
          throw forbidden('Only an owner can change owner access');
        }
        const losesOwner =
          target.role === 'owner' &&
          target.status === 'active' &&
          ((changes.role !== undefined && changes.role !== 'owner') ||
            changes.status === 'disabled');
        if (losesOwner && owners.length <= 1) {
          throw new AppError(422, 'BUSINESS_RULE', 'A shop must keep at least one active owner');
        }

        if (fullName || passwordHash) {
          await c.query(
            `UPDATE erp.users
                SET full_name = coalesce($2, full_name),
                    password_hash = coalesce($3, password_hash)
              WHERE id = $1`,
            [target.user_id, fullName ?? null, passwordHash],
          );
        }

        await updateVersioned(
          c,
          'erp.tenant_members',
          'Member',
          id,
          version,
          { role: 'role', status: 'status', branchIds: 'branch_ids' },
          changes,
        );
        return getMember(c, id);
      });
      return toMember(member);
    },
  );
}
