-- Migration 100: Grant INSERT, UPDATE on erp.tenants and platform tables to erp_app and erp_api
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT INSERT, UPDATE ON erp.tenants TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON erp.platform_invoices TO erp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON erp.platform_payments TO erp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_api') THEN
    GRANT INSERT, UPDATE ON erp.tenants TO erp_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON erp.platform_invoices TO erp_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON erp.platform_payments TO erp_api;
  END IF;
END $$;
