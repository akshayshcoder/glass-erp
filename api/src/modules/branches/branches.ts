import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { query, queryOne, updateVersioned } from '../../db/sql.js';
import { notFound } from '../../http/errors.js';
import {
  Email,
  Gstin,
  IdParams,
  NonEmpty,
  Phone,
  Pincode,
  StateCode,
  Version,
} from '../../http/validation.js';
import { BranchCode } from '../tenants/tenants.js';

/**
 * Branches (shop locations). Each carries the GSTIN it bills under.
 *
 *   GET   /v1/branches
 *   GET   /v1/branches/:id
 *   POST  /v1/branches
 *   PATCH /v1/branches/:id
 */

const BranchFields = {
  name: NonEmpty,
  gstin: Gstin.nullable().optional(),
  stateCode: StateCode,
  address: z.string().trim().nullable().optional(),
  city: z.string().trim().nullable().optional(),
  pincode: Pincode.nullable().optional(),
  phone: Phone.nullable().optional(),
  email: Email.nullable().optional(),
  allowNegativeStock: z.boolean().optional(),
};

const gstinMatchesState = (b: { gstin?: string | null; stateCode?: string }) =>
  !b.gstin || !b.stateCode || b.gstin.startsWith(b.stateCode);
const stateIssue = { message: 'GSTIN must start with the state code', path: ['gstin'] };

const CreateBranchBody = z
  .object({ code: BranchCode, ...BranchFields })
  .refine(gstinMatchesState, stateIssue);
const UpdateBranchBody = z
  .object({ version: Version, isActive: z.boolean().optional(), ...BranchFields })
  .partial({ name: true, stateCode: true })
  .refine(gstinMatchesState, stateIssue);

const COLUMNS = {
  code: 'code',
  name: 'name',
  gstin: 'gstin',
  stateCode: 'state_code',
  address: 'address',
  city: 'city',
  pincode: 'pincode',
  phone: 'phone',
  email: 'email',
  allowNegativeStock: 'allow_negative_stock',
  isActive: 'is_active',
};

interface BranchRow {
  id: string;
  code: string;
  name: string;
  gstin: string | null;
  state_code: string;
  address: string | null;
  city: string | null;
  pincode: string | null;
  phone: string | null;
  email: string | null;
  allow_negative_stock: boolean;
  is_active: boolean;
  version: number;
}

const toBranch = (r: BranchRow) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  gstin: r.gstin,
  stateCode: r.state_code,
  address: r.address,
  city: r.city,
  pincode: r.pincode,
  phone: r.phone,
  email: r.email,
  allowNegativeStock: r.allow_negative_stock,
  isActive: r.is_active,
  version: r.version,
});

export function registerBranchRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/branches', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const rows = await request.tx((c) =>
      query<BranchRow>(c, 'SELECT * FROM erp.branches ORDER BY code'),
    );
    return { items: rows.map(toBranch) };
  });

  app.get('/branches/:id', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const row = await request.tx((c) =>
      queryOne<BranchRow>(c, 'SELECT * FROM erp.branches WHERE id = $1', [id]),
    );
    if (!row) throw notFound('Branch');
    return toBranch(row);
  });

  app.post(
    '/branches',
    { preHandler: guards.tenant(Permissions.manageShop) },
    async (request, reply) => {
      const b = CreateBranchBody.parse(request.body);
      const row = await request.tx((c) =>
        queryOne<BranchRow>(
          c,
          `INSERT INTO erp.branches (code, name, gstin, state_code, address, city, pincode, phone, email,
                                   allow_negative_stock)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            b.code,
            b.name,
            b.gstin ?? null,
            b.stateCode,
            b.address ?? null,
            b.city ?? null,
            b.pincode ?? null,
            b.phone ?? null,
            b.email ?? null,
            b.allowNegativeStock ?? false,
          ],
        ),
      );
      return reply.status(201).send(toBranch(row!));
    },
  );

  app.patch(
    '/branches/:id',
    { preHandler: guards.tenant(Permissions.manageShop) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const { version, ...changes } = UpdateBranchBody.parse(request.body);
      const row = await request.tx((c) =>
        updateVersioned<BranchRow>(c, 'erp.branches', 'Branch', id, version, COLUMNS, changes),
      );
      return toBranch(row);
    },
  );
}
