import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { containsPattern, query, queryOne, updateVersioned } from '../../db/sql.js';
import { notFound } from '../../http/errors.js';
import { PageQuery, readPage, toPage } from '../../http/pagination.js';
import {
  GstRate,
  HsnCode,
  IdParams,
  NonEmpty,
  Quantity,
  Rate,
  Uuid,
  Version,
  decimal,
} from '../../http/validation.js';

/**
 * Products and categories.
 *
 *   GET   /v1/product-categories
 *   POST  /v1/product-categories
 *   GET   /v1/products?search=&kind=&categoryId=&status=active|inactive|all&pageSize=&pageToken=
 *   GET   /v1/products/:id
 *   POST  /v1/products
 *   PATCH /v1/products/:id        (send `version`; isActive=false to retire a product)
 *
 * Products are never deleted: they appear on old invoices.
 */

const Kind = z.enum(['glass', 'aluminium', 'hardware', 'service', 'other']);
/** How a sale line becomes a quantity: see erp.products.measure. */
const Measure = z.enum(['quantity', 'area', 'length', 'weight']);

const CreateCategoryBody = z.object({
  name: NonEmpty,
  kind: Kind,
  parentId: Uuid.nullable().optional(),
});

const ProductFields = {
  sku: NonEmpty,
  name: NonEmpty,
  kind: Kind,
  categoryId: Uuid.nullable().optional(),
  hsnCode: HsnCode,
  gstRate: GstRate,
  unitCode: z.string().trim().toUpperCase(),
  measure: Measure.optional(),
  thicknessMm: decimal(2, { positive: true }).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  retailPrice: Rate.optional(),
  wholesalePrice: Rate.optional(),
  purchasePrice: Rate.optional(),
  trackInventory: z.boolean().optional(),
  reorderLevel: Quantity.optional(),
};

const CreateProductBody = z.object(ProductFields);
const UpdateProductBody = z
  .object({ version: Version, isActive: z.boolean().optional(), ...ProductFields })
  .partial({ sku: true, name: true, kind: true, hsnCode: true, gstRate: true, unitCode: true });

const ListProductsQuery = PageQuery.extend({
  search: z.string().trim().optional(),
  kind: Kind.optional(),
  categoryId: Uuid.optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
});

const COLUMNS = {
  sku: 'sku',
  name: 'name',
  kind: 'kind',
  categoryId: 'category_id',
  hsnCode: 'hsn_code',
  gstRate: 'gst_rate',
  unitCode: 'unit_code',
  measure: 'measure',
  thicknessMm: 'thickness_mm',
  attributes: 'attributes',
  retailPrice: 'retail_price',
  wholesalePrice: 'wholesale_price',
  purchasePrice: 'purchase_price',
  trackInventory: 'track_inventory',
  reorderLevel: 'reorder_level',
  isActive: 'is_active',
};

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  kind: string;
  category_id: string | null;
  hsn_code: string;
  gst_rate: string;
  unit_code: string;
  measure: string;
  thickness_mm: string | null;
  attributes: Record<string, unknown>;
  retail_price: string;
  wholesale_price: string;
  purchase_price: string;
  track_inventory: boolean;
  reorder_level: string;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const toProduct = (r: ProductRow) => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  kind: r.kind,
  categoryId: r.category_id,
  hsnCode: r.hsn_code,
  gstRate: r.gst_rate,
  unitCode: r.unit_code,
  measure: r.measure,
  thicknessMm: r.thickness_mm,
  attributes: r.attributes,
  retailPrice: r.retail_price,
  wholesalePrice: r.wholesale_price,
  purchasePrice: r.purchase_price,
  trackInventory: r.track_inventory,
  reorderLevel: r.reorder_level,
  isActive: r.is_active,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function registerProductRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get(
    '/product-categories',
    { preHandler: guards.tenant(Permissions.read) },
    async (request) => {
      const rows = await request.tx((c) =>
        query<{
          id: string;
          name: string;
          kind: string;
          parent_id: string | null;
          is_active: boolean;
        }>(
          c,
          'SELECT id, name, kind, parent_id, is_active FROM erp.product_categories ORDER BY name',
        ),
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          parentId: r.parent_id,
          isActive: r.is_active,
        })),
      };
    },
  );

  app.post(
    '/product-categories',
    { preHandler: guards.tenant(Permissions.manageProducts) },
    async (request, reply) => {
      const b = CreateCategoryBody.parse(request.body);
      const row = await request.tx((c) =>
        queryOne<{ id: string }>(
          c,
          'INSERT INTO erp.product_categories (name, kind, parent_id) VALUES ($1, $2, $3) RETURNING id',
          [b.name, b.kind, b.parentId ?? null],
        ),
      );
      return reply.status(201).send({
        id: row!.id,
        name: b.name,
        kind: b.kind,
        parentId: b.parentId ?? null,
        isActive: true,
      });
    },
  );

  app.get('/products', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const q = ListProductsQuery.parse(request.query);
    const page = readPage(q);
    const rows = await request.tx((c) =>
      query<ProductRow>(
        c,
        `SELECT * FROM erp.products
         WHERE ($1::text IS NULL
                OR name ILIKE $1
                OR sku ILIKE $1
                OR coalesce(attributes->>'length', '') || ' ' || coalesce(attributes->>'lengthUnit', '') ILIKE $1
                OR coalesce(thickness_mm::text, '') || 'mm' ILIKE $1
                OR coalesce(attributes->>'finish', '') ILIKE $1)
           AND ($2::text IS NULL OR kind = $2)
           AND ($3::uuid IS NULL OR category_id = $3)
           AND ($4 = 'all' OR is_active = ($4 = 'active'))
         ORDER BY lower(name), id
         LIMIT $5 OFFSET $6`,
        [
          q.search ? containsPattern(q.search) : null,
          q.kind ?? null,
          q.categoryId ?? null,
          q.status,
          page.limit + 1,
          page.offset,
        ],
      ),
    );
    const result = toPage(rows, page);
    return { items: result.items.map(toProduct), nextPageToken: result.nextPageToken };
  });

  app.get('/products/:id', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { id } = IdParams.parse(request.params);
    const row = await request.tx((c) =>
      queryOne<ProductRow>(c, 'SELECT * FROM erp.products WHERE id = $1', [id]),
    );
    if (!row) throw notFound('Product');
    return toProduct(row);
  });

  app.post(
    '/products',
    { preHandler: guards.tenant(Permissions.manageProducts) },
    async (request, reply) => {
      const p = CreateProductBody.parse(request.body);
      const row = await request.tx((c) =>
        queryOne<ProductRow>(
          c,
          `INSERT INTO erp.products
           (sku, name, kind, category_id, hsn_code, gst_rate, unit_code, measure, thickness_mm, attributes,
            retail_price, wholesale_price, purchase_price, track_inventory, reorder_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
          [
            p.sku,
            p.name,
            p.kind,
            p.categoryId ?? null,
            p.hsnCode,
            p.gstRate,
            p.unitCode,
            p.measure ?? 'quantity',
            p.thicknessMm ?? null,
            p.attributes ?? {},
            p.retailPrice ?? '0',
            p.wholesalePrice ?? '0',
            p.purchasePrice ?? '0',
            p.trackInventory ?? p.kind !== 'service',
            p.reorderLevel ?? '0',
          ],
        ),
      );
      return reply.status(201).send(toProduct(row!));
    },
  );

  app.patch(
    '/products/:id',
    { preHandler: guards.tenant(Permissions.manageProducts) },
    async (request) => {
      const { id } = IdParams.parse(request.params);
      const { version, ...changes } = UpdateProductBody.parse(request.body);
      const row = await request.tx((c) =>
        updateVersioned<ProductRow>(c, 'erp.products', 'Product', id, version, COLUMNS, changes),
      );
      return toProduct(row);
    },
  );
}
