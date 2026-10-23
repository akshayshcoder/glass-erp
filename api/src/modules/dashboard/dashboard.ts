import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../app-context.js';
import { Permissions } from '../../auth/roles.js';
import { query, queryOne } from '../../db/sql.js';
import { toApi } from '../../http/serialize.js';
import { Uuid } from '../../http/validation.js';

/**
 * Numbers for the home screen. Read-only.
 *
 *   GET /v1/dashboard?branchId=
 *   -> { today: { sales, invoices }, month: { sales, invoices },
 *        receivable, payable, lowStockItems, recentInvoices: [...] }
 */
export function registerDashboardRoutes(app: FastifyInstance, { guards }: AppContext) {
  app.get('/dashboard', { preHandler: guards.tenant(Permissions.read) }, async (request) => {
    const { branchId } = z.object({ branchId: Uuid.optional() }).parse(request.query);
    const b = branchId ?? null;

    return request.tx(async (c) => {
      const sales = await queryOne<{
        today_sales: string;
        today_count: number;
        month_sales: string;
        month_count: number;
        receivable: string;
      }>(
        c,
        `SELECT
           coalesce(sum(grand_total) FILTER (WHERE invoice_date = erp.today()), 0)::numeric(14,2) AS today_sales,
           count(*) FILTER (WHERE invoice_date = erp.today())::int AS today_count,
           coalesce(sum(grand_total) FILTER (WHERE invoice_date >= date_trunc('month', erp.today())), 0)::numeric(14,2)
             AS month_sales,
           count(*) FILTER (WHERE invoice_date >= date_trunc('month', erp.today()))::int AS month_count,
           coalesce(sum(grand_total - amount_credited - amount_paid), 0)::numeric(14,2) AS receivable
         FROM erp.sales_invoices
         WHERE status = 'posted' AND ($1::uuid IS NULL OR branch_id = $1)`,
        [b],
      );
      const payable = await queryOne<{ payable: string }>(
        c,
        `SELECT coalesce(sum(grand_total - amount_paid), 0)::numeric(14,2) AS payable
         FROM erp.purchase_bills WHERE status = 'posted' AND ($1::uuid IS NULL OR branch_id = $1)`,
        [b],
      );
      const lowStock = await queryOne<{ n: number }>(
        c,
        `SELECT count(*)::int AS n FROM erp.v_stock
         WHERE reorder_level > 0 AND needs_reorder AND ($1::uuid IS NULL OR branch_id = $1)`,
        [b],
      );
      const recent = await query(
        c,
        `SELECT id, invoice_no, invoice_date, customer_name, grand_total, status,
                (grand_total - amount_credited - amount_paid)::numeric(14,2) AS balance_due
         FROM erp.sales_invoices
         WHERE ($1::uuid IS NULL OR branch_id = $1)
         ORDER BY created_at DESC LIMIT 8`,
        [b],
      );

      return {
        today: { sales: sales!.today_sales, invoices: sales!.today_count },
        month: { sales: sales!.month_sales, invoices: sales!.month_count },
        receivable: sales!.receivable,
        payable: payable!.payable,
        lowStockItems: lowStock!.n,
        recentInvoices: recent.map((r) => toApi(r)),
      };
    });
  });
}
