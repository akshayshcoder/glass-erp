-- =============================================================================
-- 098_saas_platform_and_features.sql
-- Multi-tenant SaaS Management & Feature Control:
--   1. Tenant feature flags (billing, inventory, wallet_fifo, multi_branch, credit_limits, reports, purchases)
--   2. Tenant subscription lifecycle (trial, active, grace_period, suspended, cancelled)
--   3. Platform billing & invoices issued by Super Admin to clients
--   4. Platform payments collected from clients & outstanding dues tracking
-- =============================================================================

SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

-- Add SaaS columns to erp.tenants
ALTER TABLE erp.tenants
  ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{"billing":true,"inventory":true,"wallet_fifo":true,"multi_branch":false,"credit_limits":true,"reports":true,"purchases":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('trial', 'active', 'grace_period', 'suspended', 'cancelled')),
  ADD COLUMN IF NOT EXISTS subscription_period text NOT NULL DEFAULT 'annual' CHECK (subscription_period IN ('monthly', 'quarterly', 'annual', 'lifetime')),
  ADD COLUMN IF NOT EXISTS subscription_amount numeric(14,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS subscription_valid_until date,
  ADD COLUMN IF NOT EXISTS grace_period_days int NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS max_branches int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS max_users int NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS admin_notes text;

-- Platform invoices (Invoices that Platform / Super Admin issues to Tenants)
CREATE TABLE IF NOT EXISTS erp.platform_invoices (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES erp.tenants (id) ON DELETE CASCADE,
  invoice_no           text        NOT NULL UNIQUE,
  billing_period_start date        NOT NULL,
  billing_period_end   date        NOT NULL,
  amount               numeric(14,2) NOT NULL CHECK (amount >= 0),
  status               text        NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid', 'paid', 'void')),
  due_date             date        NOT NULL,
  paid_at              timestamptz,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_invoices_tenant_idx ON erp.platform_invoices (tenant_id, status);

-- Platform payments (Subscription fees received by Super Admin from Tenants)
CREATE TABLE IF NOT EXISTS erp.platform_payments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES erp.tenants (id) ON DELETE CASCADE,
  invoice_id   uuid        REFERENCES erp.platform_invoices (id) ON DELETE SET NULL,
  amount       numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_date date        NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date,
  mode         text        NOT NULL CHECK (mode IN ('cash', 'upi', 'bank_transfer', 'cheque', 'card')),
  reference_no text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        REFERENCES erp.users (id)
);

CREATE INDEX IF NOT EXISTS platform_payments_tenant_idx ON erp.platform_payments (tenant_id, payment_date);

-- View: Tenant Outstanding Dues & Subscription Health
CREATE OR REPLACE VIEW erp.v_tenant_subscription_summary AS
SELECT
  t.id AS tenant_id,
  t.name AS tenant_name,
  t.legal_name,
  t.status AS tenant_status,
  t.plan,
  t.subscription_status,
  t.subscription_period,
  t.subscription_amount,
  t.subscription_valid_until,
  t.grace_period_days,
  t.max_branches,
  t.max_users,
  t.features,
  t.admin_notes,
  t.created_at,
  coalesce((SELECT sum(pi.amount) FROM erp.platform_invoices pi WHERE pi.tenant_id = t.id AND pi.status <> 'void'), 0.00)::numeric(14,2) AS total_invoiced,
  coalesce((SELECT sum(pp.amount) FROM erp.platform_payments pp WHERE pp.tenant_id = t.id), 0.00)::numeric(14,2) AS total_paid,
  (coalesce((SELECT sum(pi.amount) FROM erp.platform_invoices pi WHERE pi.tenant_id = t.id AND pi.status = 'unpaid'), 0.00))::numeric(14,2) AS outstanding_due,
  CASE
    WHEN t.subscription_valid_until IS NULL THEN 'active'
    WHEN t.subscription_valid_until >= (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'active'
    WHEN (now() AT TIME ZONE 'Asia/Kolkata')::date <= (t.subscription_valid_until + (t.grace_period_days || ' days')::interval)::date THEN 'grace_period'
    ELSE 'expired'
  END AS computed_validity_state
FROM erp.tenants t;

-- Grants for application roles
GRANT SELECT, INSERT, UPDATE ON erp.platform_invoices TO erp_api;
GRANT SELECT, INSERT, UPDATE ON erp.platform_payments TO erp_api;
GRANT SELECT ON erp.v_tenant_subscription_summary TO erp_api;

RESET ROLE;
