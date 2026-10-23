import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { queryOne, updateVersioned } from '../../db/sql.js';
import { notFound } from '../../http/errors.js';
import { tenantOf } from '../../http/request.js';
import {
  Email,
  Gstin,
  NonEmpty,
  Phone,
  Pincode,
  StateCode,
  Version,
} from '../../http/validation.js';

/**
 * Shops (tenants).
 *
 *   POST  /v1/tenants   sign-up: create a shop with its first branch; caller becomes owner
 *   GET   /v1/tenant    the currently selected shop (X-Tenant-Id)
 *   PATCH /v1/tenant    rename / legal details
 */

export const BranchCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,4}$/, '1-4 letters/digits, used in invoice numbers (e.g. MAIN)');

const CreateTenantBody = z.object({
  name: NonEmpty,
  legalName: z.string().trim().nullable().optional(),
  branch: z
    .object({
      code: BranchCode,
      name: NonEmpty,
      stateCode: StateCode,
      gstin: Gstin.optional(),
      address: z.string().trim().nullable().optional(),
      city: z.string().trim().nullable().optional(),
      pincode: Pincode.nullable().optional(),
      phone: Phone.nullable().optional(),
      email: Email.nullable().optional(),
    })
    .refine((b) => !b.gstin || b.gstin.startsWith(b.stateCode), {
      message: 'GSTIN must start with the state code',
      path: ['gstin'],
    }),
});

const UpdateTenantBody = z.object({
  version: Version,
  name: NonEmpty.optional(),
  legalName: z.string().trim().nullable().optional(),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Invalid PAN')
    .nullable()
    .optional(),
});

interface TenantRow {
  id: string;
  name: string;
  legal_name: string | null;
  pan: string | null;
  plan: string;
  status: string;
  version: number;
  created_at: Date;
}

const toTenant = (r: TenantRow) => ({
  id: r.id,
  name: r.name,
  legalName: r.legal_name,
  pan: r.pan,
  plan: r.plan,
  status: r.status,
  version: r.version,
  createdAt: r.created_at,
});

export function registerTenantRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.post('/tenants', { preHandler: guards.user }, async (request, reply) => {
    const { name, legalName, branch } = CreateTenantBody.parse(request.body);
    const tenant = await request.tx(async (c) => {
      const { id } = (await queryOne<{ id: string }>(
        c,
        'SELECT erp.register_tenant($1, $2, $3, $4, $5) AS id',
        [name, branch.code, branch.name, branch.stateCode, branch.gstin ?? null],
      ))!;
      // register_tenant switched this transaction into the new shop.
      if (legalName) {
        await c.query('UPDATE erp.tenants SET legal_name = $2 WHERE id = $1', [id, legalName]);
      }
      if (branch.address || branch.city || branch.pincode || branch.phone || branch.email) {
        await c.query(
          `UPDATE erp.branches
              SET address = $3, city = $4, pincode = $5, phone = $6, email = $7
            WHERE tenant_id = $1 AND code = $2`,
          [
            id,
            branch.code,
            branch.address ?? null,
            branch.city ?? null,
            branch.pincode ?? null,
            branch.phone ?? null,
            branch.email ?? null,
          ],
        );
      }
      return queryOne<TenantRow>(c, 'SELECT * FROM erp.tenants WHERE id = $1', [id]);
    });
    return reply.status(201).send(toTenant(tenant!));
  });

  app.get('/tenant', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { tenantId } = tenantOf(request);
    const row = await request.tx((c) =>
      queryOne<TenantRow>(c, 'SELECT * FROM erp.tenants WHERE id = $1', [tenantId]),
    );
    if (!row) throw notFound('Shop');
    return toTenant(row);
  });

  app.patch('/tenant', { preHandler: guards.tenant(Permissions.manageShop) }, async (request) => {
    const { tenantId } = tenantOf(request);
    const { version, ...changes } = UpdateTenantBody.parse(request.body);
    const row = await request.tx((c) =>
      updateVersioned<TenantRow>(
        c,
        'erp.tenants',
        'Shop',
        tenantId,
        version,
        { name: 'name', legalName: 'legal_name', pan: 'pan' },
        changes,
      ),
    );
    return toTenant(row);
  });
}
