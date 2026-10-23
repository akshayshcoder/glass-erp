-- =============================================================================
-- 000_roles.sql
-- Run ONCE per database, as a superuser (or a role with CREATEROLE + CREATE).
--
--   erp_owner : owns every table/function. Used only by migrations.
--   erp_app   : what the API connects as (through a LOGIN role that is a
--               member of erp_app). It is subject to Row Level Security and
--               has NO direct write access to stock, ledgers or audit tables.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_owner') THEN
    CREATE ROLE erp_owner NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    CREATE ROLE erp_app NOLOGIN;
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS erp   AUTHORIZATION erp_owner;
CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION erp_owner;

GRANT USAGE ON SCHEMA erp, audit TO erp_app;

-- Every function is executable by PUBLIC by default. We grant explicitly instead.
ALTER DEFAULT PRIVILEGES FOR ROLE erp_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
