import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { AppContext } from './app-context.js';
import { registerAuthRoutes } from './auth/auth.routes.js';
import { createGuards } from './auth/guards.js';
import { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';
import { configurePgTypes } from './db/pool.js';
import { type DbClient, withTransaction } from './db/transaction.js';
import { AppError, errorHandler } from './http/errors.js';
import { registerSecurity } from './http/security.js';
import { isAppPage, serveWebApp } from './http/web-app.js';
import { registerBranchRoutes } from './modules/branches/branches.js';
import { registerCreditNoteRoutes } from './modules/credit-notes/credit-notes.js';
import { registerDashboardRoutes } from './modules/dashboard/dashboard.js';
import { registerGstPeriodRoutes } from './modules/gst-periods/gst-periods.js';
import { registerMemberRoutes } from './modules/members/members.js';
import { registerPartyRoutes } from './modules/parties/parties.js';
import { registerProductRoutes } from './modules/products/products.js';
import { registerPurchaseBillRoutes } from './modules/purchases/purchase-bills.js';
import { registerSupplierPaymentRoutes } from './modules/purchases/supplier-payments.js';
import { registerQuotationRoutes } from './modules/quotations/quotations.js';
import { registerReceiptRoutes } from './modules/receipts/receipts.js';
import { registerReferenceRoutes } from './modules/reference/reference.js';
import { registerReportRoutes } from './modules/reports/reports.js';
import { registerSalesInvoiceRoutes } from './modules/sales-invoices/sales-invoices.js';
import { registerStockRoutes } from './modules/stock/stock.js';
import { registerTenantRoutes } from './modules/tenants/tenants.js';

export interface BuildAppOptions {
  config: Config;
  /** Owned by the caller (main.ts / tests), which also closes it. */
  pool: pg.Pool;
}

/** Builds the HTTP application. No network listening here: see main.ts. */
export async function buildApp({ config, pool }: BuildAppOptions): Promise<FastifyInstance> {
  configurePgTypes();
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy:
      typeof config.TRUST_PROXY === 'number'
        ? (_address: string, hop: number) => hop < (config.TRUST_PROXY as number)
        : config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  const tokens = new TokenService(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SECONDS);
  const ctx: AppContext = { config, pool, tokens, guards: createGuards(pool, tokens) };

  app.decorateRequest('auth', null);
  app.decorateRequest('tx', function <
    T,
  >(this: FastifyRequest, work: (client: DbClient) => Promise<T>) {
    return withTransaction(
      pool,
      {
        requestId: this.id,
        userId: this.auth?.userId ?? null,
        tenantId: this.auth?.tenantId ?? null,
        clientIp: this.ip,
      },
      work,
    );
  });

  app.setErrorHandler(errorHandler);
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  await registerSecurity(app, config);

  if (config.WEB_DIST_DIR) {
    // One origin for the whole product: the web app's pages, the API under /v1.
    await serveWebApp(app, config.WEB_DIST_DIR);
    app.get('/', (_request, reply) => reply.sendFile('index.html'));
  } else {
    // A friendly answer for anyone opening the API in a browser.
    app.get('/', async () => ({
      service: 'Glass ERP API',
      version: 'v1',
      health: '/healthz',
      ready: '/readyz',
      docs: 'docs/02-api.md in the repository',
    }));
  }
  app.setNotFoundHandler((request, reply) => {
    if (config.WEB_DIST_DIR && isAppPage(request.method, request.url, request.headers.accept)) {
      return reply.sendFile('index.html');
    }
    throw new AppError(404, 'NOT_FOUND', `No route ${request.method} ${request.url}`);
  });

  // Liveness: the process is up. Readiness: it can reach the database.
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  await app.register(
    async (v1) => {
      registerAuthRoutes(v1, ctx);
      registerReferenceRoutes(v1, ctx);
      registerTenantRoutes(v1, ctx);
      registerMemberRoutes(v1, ctx);
      registerBranchRoutes(v1, ctx);
      registerProductRoutes(v1, ctx);
      registerPartyRoutes(v1, ctx);
      registerStockRoutes(v1, ctx);
      registerDashboardRoutes(v1, ctx);
      // Documents
      registerQuotationRoutes(v1, ctx);
      registerSalesInvoiceRoutes(v1, ctx);
      registerReceiptRoutes(v1, ctx);
      registerCreditNoteRoutes(v1, ctx);
      registerPurchaseBillRoutes(v1, ctx);
      registerSupplierPaymentRoutes(v1, ctx);
      registerGstPeriodRoutes(v1, ctx);
      registerReportRoutes(v1, ctx);
    },
    { prefix: '/v1' },
  );

  return app;
}
