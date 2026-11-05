import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { hashPassword } from '../../auth/passwords.js';
import { query, queryOne } from '../../db/sql.js';
import { AppError, notFound } from '../../http/errors.js';
import {
  Email,
  Gstin,
  IdParams,
  IsoDate,
  NonEmpty,
  Phone,
  PositiveMoney,
  StateCode,
} from '../../http/validation.js';

const TenantCreateSchema = z.object({
  name: NonEmpty,
  legalName: z.string().trim().optional().transform((v) => v || undefined),
  pan: z.string().trim().toUpperCase().optional().transform((v) => v || undefined).pipe(
    z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN').optional()
  ),
  plan: z.enum(['trial', 'starter', 'professional', 'enterprise']).default('starter'),
  subscriptionPeriod: z.enum(['monthly', 'quarterly', 'annual', 'lifetime']).default('annual'),
  subscriptionAmount: PositiveMoney.default('0.00'),
  subscriptionValidUntil: IsoDate.optional(),
  gracePeriodDays: z.number().int().min(0).max(90).default(7),
  maxBranches: z.number().int().min(1).max(100).default(1),
  maxUsers: z.number().int().min(1).max(500).default(5),
  features: z.record(z.string(), z.boolean()).optional(),
  adminNotes: z.string().trim().max(2000).optional(),
  owner: z.object({
    fullName: NonEmpty,
    phone: z.string().trim().optional().transform((v) => v || undefined).pipe(Phone.optional()),
    email: z.string().trim().toLowerCase().optional().transform((v) => v || undefined).pipe(Email.optional()),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  }).refine((o) => o.phone || o.email, {
    message: 'Owner phone or email is required',
    path: ['phone'],
  }),
  branch: z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/).default('MAIN'),
    name: NonEmpty.default('Main Branch'),
    stateCode: StateCode.default('07'),
    gstin: z.string().trim().toUpperCase().optional().transform((v) => v || undefined).pipe(Gstin.optional()),
  }).optional().default({ code: 'MAIN', name: 'Main Branch', stateCode: '07' }),
});

const TenantUpdateSchema = z.object({
  name: NonEmpty.optional(),
  legalName: z.string().trim().nullable().optional(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/).nullable().optional(),
  plan: z.enum(['trial', 'starter', 'professional', 'enterprise']).optional(),
  status: z.enum(['active', 'suspended', 'closed']).optional(),
  subscriptionStatus: z.enum(['trial', 'active', 'grace_period', 'suspended', 'cancelled']).optional(),
  subscriptionPeriod: z.enum(['monthly', 'quarterly', 'annual', 'lifetime']).optional(),
  subscriptionAmount: PositiveMoney.optional(),
  subscriptionValidUntil: IsoDate.nullable().optional(),
  gracePeriodDays: z.number().int().min(0).max(90).optional(),
  maxBranches: z.number().int().min(1).max(100).optional(),
  maxUsers: z.number().int().min(1).max(500).optional(),
  adminNotes: z.string().trim().max(2000).nullable().optional(),
});

const FeaturesUpdateSchema = z.object({
  billing: z.boolean().optional(),
  inventory: z.boolean().optional(),
  wallet_fifo: z.boolean().optional(),
  multi_branch: z.boolean().optional(),
  credit_limits: z.boolean().optional(),
  reports: z.boolean().optional(),
  purchases: z.boolean().optional(),
});

const PaymentRecordSchema = z.object({
  amount: PositiveMoney,
  paymentDate: IsoDate.optional(),
  mode: z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'card']),
  referenceNo: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
});

const ExtendValiditySchema = z.object({
  days: z.number().int().min(1).max(3650),
});

export function registerSuperAdminRoutes(app: FastifyInstance, { guards, tokens }: AppContext) {
  const guard = { preHandler: guards.platformAdmin };

  // 1. List all client tenants with subscription status and dues
  app.get('/super-admin/tenants', guard, async (request) => {
    return request.tx(async (c) => {
      const rows = await query<Record<string, unknown>>(
        c,
        `SELECT
           v.*,
           (SELECT jsonb_build_object('id', u.id, 'fullName', u.full_name, 'phone', u.phone, 'email', u.email)
            FROM erp.tenant_members m JOIN erp.users u ON u.id = m.user_id
            WHERE m.tenant_id = v.tenant_id AND m.role = 'owner'
            LIMIT 1) AS owner,
           (SELECT count(*)::int FROM erp.tenant_members m WHERE m.tenant_id = v.tenant_id AND m.status = 'active') AS active_users_count,
           (SELECT count(*)::int FROM erp.branches b WHERE b.tenant_id = v.tenant_id AND b.is_active = true) AS active_branches_count
         FROM erp.v_tenant_subscription_summary v
         ORDER BY v.created_at DESC`,
      );
      return rows.map((r: any) => ({
        tenantId: r.tenant_id,
        tenantName: r.tenant_name ?? '',
        legalName: r.legal_name ?? null,
        tenantStatus: r.tenant_status ?? 'active',
        plan: r.plan ?? 'starter',
        subscriptionStatus: r.subscription_status ?? 'active',
        subscriptionPeriod: r.subscription_period ?? 'annual',
        subscriptionAmount: r.subscription_amount ?? '0.00',
        subscriptionValidUntil: r.subscription_valid_until ?? null,
        gracePeriodDays: Number(r.grace_period_days ?? 7),
        maxBranches: Number(r.max_branches ?? 1),
        maxUsers: Number(r.max_users ?? 5),
        features: r.features ?? {},
        adminNotes: r.admin_notes ?? null,
        createdAt: r.created_at,
        totalInvoiced: r.total_invoiced ?? '0.00',
        totalPaid: r.total_paid ?? '0.00',
        outstandingDue: r.outstanding_due ?? '0.00',
        computedValidityState: r.computed_validity_state ?? 'active',
        owner: r.owner ?? null,
        activeUsersCount: Number(r.active_users_count ?? 1),
        activeBranchesCount: Number(r.active_branches_count ?? 1),
      }));
    });
  });

  // 2. Create new client tenant
  app.post('/super-admin/tenants', guard, async (request, reply) => {
    const body = TenantCreateSchema.parse(request.body);

    const result = await request.tx(async (c) => {
      // 1. Find or create user
      let ownerId: string;
      const existingUser = await queryOne<{ id: string }>(
        c,
        'SELECT id FROM erp.users WHERE (email IS NOT NULL AND lower(email) = lower($1)) OR (phone IS NOT NULL AND phone = $2)',
        [body.owner.email ?? null, body.owner.phone ?? null],
      );

      if (existingUser) {
        ownerId = existingUser.id;
      } else {
        const hash = await hashPassword(body.owner.password);
        const newUser = await queryOne<{ id: string }>(
          c,
          `INSERT INTO erp.users (full_name, email, phone, password_hash)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [body.owner.fullName, body.owner.email ?? null, body.owner.phone ?? null, hash],
        );
        ownerId = newUser!.id;
      }

      // 2. Create tenant
      const defaultFeatures = {
        billing: true,
        inventory: true,
        wallet_fifo: true,
        multi_branch: false,
        credit_limits: true,
        reports: true,
        purchases: true,
        ...body.features,
      };

      const tenant = await queryOne<{ id: string }>(
        c,
        `INSERT INTO erp.tenants
           (name, legal_name, pan, plan, features, subscription_period,
            subscription_amount, subscription_valid_until, grace_period_days, max_branches, max_users, admin_notes)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          body.name,
          body.legalName ?? null,
          body.pan ?? null,
          body.plan,
          JSON.stringify(defaultFeatures),
          body.subscriptionPeriod,
          body.subscriptionAmount,
          body.subscriptionValidUntil ?? null,
          body.gracePeriodDays,
          body.maxBranches,
          body.maxUsers,
          body.adminNotes ?? null,
        ],
      );

      const tenantId = tenant!.id;

      // 3. Make user owner in tenant_members
      await c.query(
        `INSERT INTO erp.tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [tenantId, ownerId],
      );

      // 4. Create initial branch
      const branch = body.branch ?? { code: 'MAIN', name: 'Main Branch', stateCode: '07', gstin: null };
      await c.query(
        `INSERT INTO erp.branches (tenant_id, code, name, state_code, gstin)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, branch.code, branch.name, branch.stateCode, branch.gstin ?? null],
      );

      // 5. If subscription amount > 0, generate initial platform invoice
      if (Number(body.subscriptionAmount) > 0) {
        const invNo = `SUB-${new Date().getFullYear()}-${tenantId.slice(0, 6).toUpperCase()}`;
        const today = new Date().toISOString().slice(0, 10);
        await c.query(
          `INSERT INTO erp.platform_invoices
             (tenant_id, invoice_no, billing_period_start, billing_period_end, amount, due_date, status)
           VALUES ($1, $2, $3, coalesce($4, ($3::date + interval '1 year')::date), $5, ($3::date + interval '15 days')::date, 'unpaid')`,
          [tenantId, invNo, today, body.subscriptionValidUntil ?? null, body.subscriptionAmount],
        );
      }

      return { tenantId, ownerId };
    });

    return reply.status(201).send(result);
  });

  // 3. Update client tenant subscription, status & limits
  app.put('/super-admin/tenants/:id', guard, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = TenantUpdateSchema.parse(request.body);

    const updated = await request.tx(async (c) => {
      const row = await queryOne(
        c,
        `UPDATE erp.tenants SET
           name = coalesce($2, name),
           legal_name = coalesce($3, legal_name),
           pan = coalesce($4, pan),
           plan = coalesce($5, plan),
           status = coalesce($6, status),
           subscription_status = coalesce($7, subscription_status),
           subscription_period = coalesce($8, subscription_period),
           subscription_amount = coalesce($9, subscription_amount),
           subscription_valid_until = CASE WHEN $10::boolean THEN $11::date ELSE subscription_valid_until END,
           grace_period_days = coalesce($12, grace_period_days),
           max_branches = coalesce($13, max_branches),
           max_users = coalesce($14, max_users),
           admin_notes = coalesce($15, admin_notes),
           updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [
          id,
          body.name ?? null,
          body.legalName ?? null,
          body.pan ?? null,
          body.plan ?? null,
          body.status ?? null,
          body.subscriptionStatus ?? null,
          body.subscriptionPeriod ?? null,
          body.subscriptionAmount ?? null,
          body.subscriptionValidUntil !== undefined,
          body.subscriptionValidUntil ?? null,
          body.gracePeriodDays ?? null,
          body.maxBranches ?? null,
          body.maxUsers ?? null,
          body.adminNotes ?? null,
        ],
      );
      if (!row) throw notFound('Tenant');
      return row;
    });

    return updated;
  });

  // 4. Update tenant feature toggles
  app.put('/super-admin/tenants/:id/features', guard, async (request) => {
    const { id } = IdParams.parse(request.params);
    const body = FeaturesUpdateSchema.parse(request.body);

    return request.tx(async (c) => {
      const current = await queryOne<{ features: Record<string, boolean> }>(
        c,
        'SELECT features FROM erp.tenants WHERE id = $1',
        [id],
      );
      if (!current) throw notFound('Tenant');

      const merged = { ...current.features, ...body };
      await c.query(
        'UPDATE erp.tenants SET features = $2::jsonb, updated_at = now() WHERE id = $1',
        [id, JSON.stringify(merged)],
      );
      return { id, features: merged };
    });
  });

  // 5. List platform payments & invoices for tenant
  app.get('/super-admin/tenants/:id/payments', guard, async (request) => {
    const { id } = IdParams.parse(request.params);
    return request.tx(async (c) => {
      const payments = await query<Record<string, any>>(
        c,
        'SELECT * FROM erp.platform_payments WHERE tenant_id = $1 ORDER BY payment_date DESC, created_at DESC',
        [id],
      );
      const invoices = await query<Record<string, any>>(
        c,
        'SELECT * FROM erp.platform_invoices WHERE tenant_id = $1 ORDER BY due_date DESC',
        [id],
      );
      return {
        payments: payments.map((p) => ({
          id: p.id,
          tenantId: p.tenant_id,
          invoiceId: p.invoice_id,
          amount: p.amount,
          paymentDate: p.payment_date,
          mode: p.mode,
          referenceNo: p.reference_no,
          notes: p.notes,
          createdAt: p.created_at,
        })),
        invoices: invoices.map((inv) => ({
          id: inv.id,
          tenantId: inv.tenant_id,
          invoiceNo: inv.invoice_no,
          billingPeriodStart: inv.billing_period_start,
          billingPeriodEnd: inv.billing_period_end,
          amount: inv.amount,
          status: inv.status,
          dueDate: inv.due_date,
          paidAt: inv.paid_at,
          notes: inv.notes,
          createdAt: inv.created_at,
        })),
      };
    });
  });

  // 6. Record payment received from tenant
  app.post('/super-admin/tenants/:id/payments', guard, async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const body = PaymentRecordSchema.parse(request.body);

    const payment = await request.tx(async (c) => {
      const p = await queryOne(
        c,
        `INSERT INTO erp.platform_payments
           (tenant_id, amount, payment_date, mode, reference_no, notes, created_by)
         VALUES ($1, $2, coalesce($3::date, (now() AT TIME ZONE 'Asia/Kolkata')::date), $4, $5, $6, $7)
         RETURNING *`,
        [
          id,
          body.amount,
          body.paymentDate ?? null,
          body.mode,
          body.referenceNo ?? null,
          body.notes ?? null,
          request.auth?.userId,
        ],
      );

      // Auto mark oldest unpaid invoice as paid if amount matches or exceeds
      const unpaid = await queryOne<{ id: string; amount: string }>(
        c,
        `SELECT id, amount FROM erp.platform_invoices WHERE tenant_id = $1 AND status = 'unpaid' ORDER BY due_date ASC LIMIT 1`,
        [id],
      );
      if (unpaid && Number(body.amount) >= Number(unpaid.amount)) {
        await c.query(
          `UPDATE erp.platform_invoices SET status = 'paid', paid_at = now() WHERE id = $1`,
          [unpaid.id],
        );
      }

      return p;
    });

    return reply.status(201).send(payment);
  });

  // 7. Extend subscription validity
  app.post('/super-admin/tenants/:id/extend-validity', guard, async (request) => {
    const { id } = IdParams.parse(request.params);
    const { days } = ExtendValiditySchema.parse(request.body);

    return request.tx(async (c) => {
      const current = await queryOne<{ subscription_valid_until: string | null }>(
        c,
        'SELECT subscription_valid_until FROM erp.tenants WHERE id = $1',
        [id],
      );
      if (!current) throw notFound('Tenant');

      const updated = await queryOne(
        c,
        `UPDATE erp.tenants
         SET subscription_valid_until = (coalesce(greatest(subscription_valid_until, (now() AT TIME ZONE 'Asia/Kolkata')::date), (now() AT TIME ZONE 'Asia/Kolkata')::date) + ($2 || ' days')::interval)::date,
             subscription_status = 'active',
             status = 'active',
             updated_at = now()
         WHERE id = $1
         RETURNING id, subscription_valid_until, subscription_status, status`,
        [id, days],
      );
      return updated;
    });
  });

  // 8. Impersonate Client (Super Admin support mode)
  app.post('/super-admin/impersonate/:id', guard, async (request) => {
    const { id } = IdParams.parse(request.params);

    return request.tx(async (c) => {
      const tenant = await queryOne<{ id: string; name: string }>(
        c,
        'SELECT id, name FROM erp.tenants WHERE id = $1',
        [id],
      );
      if (!tenant) throw notFound('Tenant');

      // Find owner of tenant
      const owner = await queryOne<{ user_id: string }>(
        c,
        `SELECT user_id FROM erp.tenant_members WHERE tenant_id = $1 AND role = 'owner' LIMIT 1`,
        [id],
      );
      if (!owner) throw new AppError(400, 'BUSINESS_RULE', 'Tenant has no owner to impersonate');

      // Issue temporary tokens for this owner
      const sessionId = request.auth!.sessionId;
      const accessToken = await tokens.createAccessToken({
        userId: owner.user_id,
        sessionId,
      });

      return {
        tenantId: tenant.id,
        tenantName: tenant.name,
        accessToken,
        expiresIn: tokens.accessTokenTtlSeconds,
      };
    });
  });
}
