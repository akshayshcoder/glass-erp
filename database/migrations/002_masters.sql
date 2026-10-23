-- =============================================================================
-- 002_masters.sql
-- Tenants (shops), users, branches, products, customers/suppliers.
--
-- Conventions
--   * Every tenant-owned table has tenant_id and UNIQUE (tenant_id, id).
--     Foreign keys between them are composite (tenant_id, x_id), so a row can
--     never point at another shop's data, even through an API bug.
--     (Plain FK checks bypass Row Level Security; composite FKs do not.)
--   * Money: numeric(14,2). Quantity: numeric(14,3). Never float.
--   * Masters are never deleted, only deactivated (is_active = false).
--   * Status-like columns are text + CHECK (easier to evolve than enums).
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

-- ---------- Global reference data (no tenant) --------------------------------
CREATE TABLE erp.states (                       -- GST state codes
  code char(2) PRIMARY KEY CHECK (code ~ '^[0-9]{2}$'),
  name text    NOT NULL UNIQUE
);

CREATE TABLE erp.units (
  code     text     PRIMARY KEY CHECK (code ~ '^[A-Z]{2,6}$'),
  name     text     NOT NULL,
  gst_uqc  text     NOT NULL CHECK (gst_uqc ~ '^[A-Z]{3}$'),   -- unit code in GST returns
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 3)
);

-- ---------- Tenants & users --------------------------------------------------
CREATE TABLE erp.tenants (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        NOT NULL CHECK (btrim(name) <> ''),
  legal_name text,
  pan        char(10)    CHECK (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  plan       text        NOT NULL DEFAULT 'trial',
  settings   jsonb       NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    int         NOT NULL DEFAULT 1
);

-- A user is a person. One person can belong to many shops (e.g. the GST
-- accountant), with a different role in each.
CREATE TABLE erp.users (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name          text        NOT NULL CHECK (btrim(full_name) <> ''),
  email              text        CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone              text        CHECK (phone ~ '^\+?[0-9]{10,15}$'),
  password_hash      text,                                  -- argon2id, set by the API only
  is_platform_admin  boolean     NOT NULL DEFAULT false,
  status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_login_count int         NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            int         NOT NULL DEFAULT 1,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_uq ON erp.users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_phone_uq ON erp.users (phone)        WHERE phone IS NOT NULL;

CREATE TABLE erp.tenant_members (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL DEFAULT erp.current_tenant_id() REFERENCES erp.tenants (id),
  user_id    uuid        NOT NULL REFERENCES erp.users (id),
  role       text        NOT NULL CHECK (role IN
               ('owner', 'admin', 'manager', 'billing', 'storekeeper', 'accountant', 'viewer')),
  branch_ids uuid[],                                       -- NULL = all branches
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    int         NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX tenant_members_user_idx ON erp.tenant_members (user_id);

-- ---------- Branches (a shop location; carries the GSTIN) --------------------
CREATE TABLE erp.branches (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL DEFAULT erp.current_tenant_id() REFERENCES erp.tenants (id),
  code                 text        NOT NULL CHECK (code ~ '^[A-Z0-9]{1,4}$'),  -- used in invoice numbers
  name                 text        NOT NULL CHECK (btrim(name) <> ''),
  gstin                text        CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code           char(2)     NOT NULL REFERENCES erp.states (code),
  address              text,
  city                 text,
  pincode              text        CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  phone                text,
  email                text,
  allow_negative_stock boolean     NOT NULL DEFAULT false,
  is_active            boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid,
  version              int         NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (gstin IS NULL OR left(gstin, 2) = state_code)
);

-- ---------- Products ---------------------------------------------------------
CREATE TABLE erp.product_categories (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL DEFAULT erp.current_tenant_id() REFERENCES erp.tenants (id),
  parent_id  uuid,
  name       text        NOT NULL CHECK (btrim(name) <> ''),
  kind       text        NOT NULL CHECK (kind IN ('glass', 'aluminium', 'hardware', 'service', 'other')),
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  version    int         NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES erp.product_categories (tenant_id, id)
);

CREATE TABLE erp.products (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid          NOT NULL DEFAULT erp.current_tenant_id() REFERENCES erp.tenants (id),
  category_id      uuid,
  sku              text          NOT NULL CHECK (btrim(sku) <> ''),
  name             text          NOT NULL CHECK (btrim(name) <> ''),
  kind             text          NOT NULL CHECK (kind IN ('glass', 'aluminium', 'hardware', 'service', 'other')),
  hsn_code         text          NOT NULL CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  gst_rate         numeric(5,2)  NOT NULL CHECK (gst_rate BETWEEN 0 AND 100),
  unit_code        text          NOT NULL REFERENCES erp.units (code),
  -- How a sales line turns into a quantity:
  --   quantity : qty typed directly             (hardware: 10 PCS)
  --   area     : width x height x pieces        (glass: sq ft)
  --   length   : length x pieces                (aluminium section: running ft)
  --   weight   : weighed quantity               (aluminium: kg)
  measure          text          NOT NULL DEFAULT 'quantity'
                                 CHECK (measure IN ('quantity', 'area', 'length', 'weight')),
  thickness_mm     numeric(6,2)  CHECK (thickness_mm > 0),
  attributes       jsonb         NOT NULL DEFAULT '{}',    -- colour, finish, brand, bar length...
  retail_price     numeric(14,4) NOT NULL DEFAULT 0 CHECK (retail_price >= 0),     -- B2C
  wholesale_price  numeric(14,4) NOT NULL DEFAULT 0 CHECK (wholesale_price >= 0),  -- B2B
  purchase_price   numeric(14,4) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0),
  track_inventory  boolean       NOT NULL DEFAULT true,
  reorder_level    numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  is_active        boolean       NOT NULL DEFAULT true,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int           NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, sku),
  FOREIGN KEY (tenant_id, category_id) REFERENCES erp.product_categories (tenant_id, id),
  CHECK (kind <> 'service' OR NOT track_inventory)
);
CREATE INDEX products_name_idx ON erp.products (tenant_id, lower(name));

-- ---------- Parties (customers and suppliers) ----------------------------------
CREATE TABLE erp.parties (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid          NOT NULL DEFAULT erp.current_tenant_id() REFERENCES erp.tenants (id),
  kind             text          NOT NULL CHECK (kind IN ('customer', 'supplier', 'both')),
  name             text          NOT NULL CHECK (btrim(name) <> ''),
  contact_person   text,
  phone            text,
  email            text,
  gstin            text          CHECK (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  state_code       char(2)       REFERENCES erp.states (code),      -- place of supply
  billing_address  text,
  shipping_address text,
  pincode          text          CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  credit_limit     numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),  -- 0 = no limit
  credit_days      int           NOT NULL DEFAULT 0 CHECK (credit_days >= 0),
  is_active        boolean       NOT NULL DEFAULT true,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  created_by       uuid,
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  updated_by       uuid,
  version          int           NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK (gstin IS NULL OR state_code = left(gstin, 2))
);
CREATE UNIQUE INDEX parties_gstin_uq ON erp.parties (tenant_id, gstin) WHERE gstin IS NOT NULL;
CREATE INDEX parties_name_idx  ON erp.parties (tenant_id, lower(name));
CREATE INDEX parties_phone_idx ON erp.parties (tenant_id, phone);

-- ---------- GST period locks ----------------------------------------------------
-- When the accountant files a month's return, that month is locked for the
-- branch (GSTIN): nothing dated in it can be posted or cancelled any more.
-- Later corrections go through credit notes dated in an open month.
CREATE TABLE erp.gst_period_locks (
  id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid        NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id uuid        NOT NULL,
  period    text        NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),   -- 'YYYY-MM'
  note      text,
  locked_at timestamptz NOT NULL DEFAULT now(),
  locked_by uuid        DEFAULT erp.current_user_id(),
  UNIQUE (tenant_id, branch_id, period),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id)
);
CREATE TRIGGER gst_period_locks_audit AFTER INSERT OR UPDATE OR DELETE ON erp.gst_period_locks
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

-- Called by every posting / cancelling function.
-- VOLATILE on purpose: it must see locks committed while it waited for the
-- branch row (a STABLE function would reuse the caller's older snapshot).
CREATE FUNCTION erp.assert_period_open(p_branch_id uuid, p_date date) RETURNS void
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
BEGIN
  -- Shared lock: many documents can post together, but lock_gst_period (which
  -- takes FOR NO KEY UPDATE) waits for them, and they wait for it. No document can
  -- slip into a month while it is being locked.
  PERFORM 1 FROM erp.branches WHERE tenant_id = v_tenant AND id = p_branch_id FOR SHARE;
  IF EXISTS (SELECT 1 FROM erp.gst_period_locks
             WHERE tenant_id = v_tenant AND branch_id = p_branch_id
               AND period = to_char(p_date, 'YYYY-MM')) THEN
    RAISE EXCEPTION 'GST period % is locked (return already filed)', to_char(p_date, 'YYYY-MM')
      USING ERRCODE = 'ERP05', HINT = 'Use a credit note dated in an open month';
  END IF;
END $$;

CREATE FUNCTION erp.lock_gst_period(p_branch_id uuid, p_period text, p_note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'accountant');
  -- NO KEY UPDATE conflicts with the FOR SHARE taken by posting functions, but
  -- not with foreign-key checks, so creating drafts is never blocked.
  PERFORM 1 FROM erp.branches WHERE tenant_id = v_tenant AND id = p_branch_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Branch % not found', p_branch_id USING ERRCODE = 'ERP04';
  END IF;
  INSERT INTO erp.gst_period_locks (tenant_id, branch_id, period, note)
  VALUES (v_tenant, p_branch_id, p_period, p_note)
  ON CONFLICT (tenant_id, branch_id, period) DO NOTHING;
END $$;

-- Unlocking is rare and sensitive (e.g. accountant locked the wrong month):
-- owner/admin only, reason mandatory, logged as an event and a row delete.
CREATE FUNCTION erp.unlock_gst_period(p_branch_id uuid, p_period text, p_reason text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
BEGIN
  PERFORM erp.require_role('owner', 'admin');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A reason is required to unlock a GST period' USING ERRCODE = 'ERP04';
  END IF;
  DELETE FROM erp.gst_period_locks
  WHERE tenant_id = v_tenant AND branch_id = p_branch_id AND period = p_period;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Period % is not locked', p_period USING ERRCODE = 'ERP04';
  END IF;
  PERFORM audit.log_event('gst_period.unlocked', 'branch', p_branch_id::text,
                          jsonb_build_object('period', p_period, 'reason', p_reason));
END $$;

-- ---------- Triggers: metadata + audit ---------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants', 'users', 'tenant_members', 'branches',
                           'product_categories', 'products', 'parties'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON erp.%I
                    FOR EACH ROW EXECUTE FUNCTION erp.stamp_row()', t || '_stamp', t);
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON erp.%I
                    FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change(%L)',
                   t || '_audit', t, CASE t WHEN 'users' THEN 'password_hash' ELSE '' END);
  END LOOP;
END $$;

-- ---------- Authorisation helpers --------------------------------------------
-- Defence in depth: the API checks roles too, but business functions re-check.
CREATE FUNCTION erp.require_role(VARIADIC p_roles text[]) RETURNS void
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM erp.tenant_members m
    JOIN erp.users u ON u.id = m.user_id
    WHERE m.tenant_id = erp.require_tenant_id()
      AND m.user_id   = erp.current_user_id()
      AND m.status = 'active' AND u.status = 'active'
      AND m.role = ANY (p_roles)) THEN
    RAISE EXCEPTION 'Permission denied: requires role %', array_to_string(p_roles, ' / ')
      USING ERRCODE = '42501';
  END IF;
END $$;

-- Sign-up: the (already created) user in app.user_id creates a new shop with
-- its first branch and becomes its owner.
CREATE FUNCTION erp.register_tenant(
  p_name        text,
  p_branch_code text,
  p_branch_name text,
  p_state_code  char(2),
  p_gstin       text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_user   uuid := erp.current_user_id();
  v_tenant uuid := gen_random_uuid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No user in request context' USING ERRCODE = 'ERP00';
  END IF;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);

  INSERT INTO erp.tenants (id, name) VALUES (v_tenant, p_name);
  INSERT INTO erp.tenant_members (tenant_id, user_id, role) VALUES (v_tenant, v_user, 'owner');
  INSERT INTO erp.branches (tenant_id, code, name, state_code, gstin)
  VALUES (v_tenant, p_branch_code, p_branch_name, p_state_code, p_gstin);
  RETURN v_tenant;
END $$;

RESET ROLE;
