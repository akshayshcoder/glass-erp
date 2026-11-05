-- Migration 099: Platform Admin RLS Policies for SaaS Management
CREATE OR REPLACE FUNCTION erp.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce(
    (SELECT u.is_platform_admin FROM erp.users u WHERE u.id = erp.current_user_id()),
    false
  );
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION erp.is_platform_admin() TO erp_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_api') THEN
    GRANT EXECUTE ON FUNCTION erp.is_platform_admin() TO erp_api;
  END IF;
END $$;

-- Allow platform admin full access on erp.tenants
DROP POLICY IF EXISTS platform_admin_tenants ON erp.tenants;
CREATE POLICY platform_admin_tenants ON erp.tenants FOR ALL
  USING (erp.is_platform_admin())
  WITH CHECK (erp.is_platform_admin());

-- Allow platform admin full access on erp.tenant_members
DROP POLICY IF EXISTS platform_admin_members ON erp.tenant_members;
CREATE POLICY platform_admin_members ON erp.tenant_members FOR ALL
  USING (erp.is_platform_admin())
  WITH CHECK (erp.is_platform_admin());

-- Allow platform admin full access on erp.branches
DROP POLICY IF EXISTS platform_admin_branches ON erp.branches;
CREATE POLICY platform_admin_branches ON erp.branches FOR ALL
  USING (erp.is_platform_admin())
  WITH CHECK (erp.is_platform_admin());
