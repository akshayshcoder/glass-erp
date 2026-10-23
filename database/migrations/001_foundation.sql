-- =============================================================================
-- 001_foundation.sql
-- Request context, shared trigger functions, audit trail.
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

-- -----------------------------------------------------------------------------
-- Request context
-- The API must run every request inside a transaction and start it with:
--
--   SELECT set_config('app.tenant_id',  $tenantId,  true),
--          set_config('app.user_id',    $userId,    true),
--          set_config('app.request_id', $requestId, true),
--          set_config('app.client_ip',  $clientIp,  true);
--
-- `true` = transaction-local, so a pooled connection never leaks one tenant's
-- context into the next request.
-- -----------------------------------------------------------------------------
CREATE FUNCTION erp.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION erp.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION erp.require_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_tenant uuid := erp.current_tenant_id();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'No tenant set in request context' USING ERRCODE = 'ERP00';
  END IF;
  RETURN v_tenant;
END $$;

-- Business "today" is always Indian time, whatever the server timezone is.
CREATE FUNCTION erp.today() RETURNS date
LANGUAGE sql STABLE AS
$$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;

-- Indian financial year: 1 April – 31 March. 2026-10-19 -> '2026-27'
CREATE FUNCTION erp.financial_year_of(d date) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT y || '-' || lpad(((y + 1) % 100)::text, 2, '0')
  FROM (SELECT CASE WHEN extract(month FROM d) >= 4
                    THEN extract(year FROM d)::int
                    ELSE extract(year FROM d)::int - 1 END AS y) s
$$;

-- True when the current statement runs as the table owner, i.e. inside one of
-- our SECURITY DEFINER business functions (post_sales_invoice, ...), and not as
-- the API role writing to the table directly.
CREATE FUNCTION erp.is_owner_context(p_table oid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  FROM pg_class c WHERE c.oid = p_table
$$;

-- Keys whose values differ between two row images.
CREATE FUNCTION erp.changed_keys(p_old jsonb, p_new jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(k ORDER BY k), '{}')
  FROM (SELECT jsonb_object_keys(coalesce(p_old, '{}') || coalesce(p_new, '{}')) AS k) keys
  WHERE p_old -> k IS DISTINCT FROM p_new -> k
$$;

-- -----------------------------------------------------------------------------
-- Standard row metadata: created_at/by, updated_at/by, version.
-- `version` drives optimistic locking: the API updates with
--   UPDATE ... WHERE id = $1 AND version = $2
-- and treats "0 rows updated" as "someone else changed this record first".
-- -----------------------------------------------------------------------------
CREATE FUNCTION erp.stamp_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    NEW.created_by := erp.current_user_id();
    NEW.updated_at := NEW.created_at;
    NEW.updated_by := NEW.created_by;
    NEW.version    := 1;
  ELSE
    NEW.created_at := OLD.created_at;          -- history cannot be rewritten
    NEW.created_by := OLD.created_by;
    NEW.updated_at := now();
    NEW.updated_by := erp.current_user_id();
    NEW.version    := OLD.version + 1;
  END IF;
  RETURN NEW;
END $$;

-- Ledgers and logs are append-only: corrections are new reversing entries.
CREATE FUNCTION erp.forbid_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'ERP03';
END $$;

-- -----------------------------------------------------------------------------
-- Document guard, shared by every document table (invoices, receipts, ...).
--   TG_ARGV[0] : comma-separated system columns. Only our business functions
--                may set them (doc number, posted_at, amount_paid, ...).
--   TG_ARGV[1] : comma-separated columns that may still change after posting.
-- Rules:
--   * The API can only create and edit DRAFTS.
--   * Posting / cancelling happens only through business functions.
--   * Posted documents are frozen except for the TG_ARGV[1] columns.
--   * Cancelled documents are frozen completely. Nothing posted is ever deleted.
-- -----------------------------------------------------------------------------
CREATE FUNCTION erp.guard_document() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_system   text[] := string_to_array(TG_ARGV[0], ',');
  v_mutable  text[] := string_to_array(TG_ARGV[1], ',')
                       || ARRAY['status', 'updated_at', 'updated_by', 'version'];
  v_owner    boolean := erp.is_owner_context(TG_RELID);
  -- Generated columns are still NULL in a BEFORE trigger: never count them as changed.
  v_computed text[] := ARRAY(SELECT attname::text FROM pg_attribute
                             WHERE attrelid = TG_RELID AND attgenerated <> '');
  v_changed  text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION '% is %; it cannot be deleted (cancel it instead)', TG_TABLE_NAME, OLD.status
        USING ERRCODE = 'ERP03';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NOT v_owner THEN
      IF NEW.status <> 'draft' OR EXISTS (
           SELECT 1 FROM unnest(v_system) c
           WHERE c <> 'status' AND to_jsonb(NEW) -> c NOT IN ('null'::jsonb, '0'::jsonb)) THEN
        RAISE EXCEPTION 'New % must be a draft without system fields', TG_TABLE_NAME
          USING ERRCODE = 'ERP03';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  v_changed := erp.changed_keys(to_jsonb(OLD) - v_computed, to_jsonb(NEW) - v_computed);

  IF OLD.status = 'draft' THEN
    IF NOT v_owner AND v_changed && (v_system || ARRAY['status']) THEN
      RAISE EXCEPTION 'Use the business functions to post a %', TG_TABLE_NAME
        USING ERRCODE = 'ERP03';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'cancelled' OR NOT v_owner OR NOT (v_changed <@ v_mutable) THEN
    RAISE EXCEPTION '% is %; it cannot be edited', TG_TABLE_NAME, OLD.status
      USING ERRCODE = 'ERP03',
            DETAIL = format('changed columns: %s', array_to_string(v_changed, ', '));
  END IF;
  RETURN NEW;
END $$;

-- Lines / allocations may only change while their parent document is a draft.
--   TG_ARGV[0] : parent table name, TG_ARGV[1] : FK column pointing at it.
CREATE FUNCTION erp.guard_document_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_row    jsonb := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  v_parent uuid  := (v_row ->> TG_ARGV[1])::uuid;
  v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) -> TG_ARGV[1]) <> (to_jsonb(NEW) -> TG_ARGV[1]) THEN
    RAISE EXCEPTION 'Rows cannot be moved to another %', TG_ARGV[0] USING ERRCODE = 'ERP03';
  END IF;

  -- FOR SHARE waits for a concurrent post/cancel of the parent to finish, so a
  -- line can never sneak in after the totals were checked.
  EXECUTE format('SELECT status FROM erp.%I WHERE id = $1 FOR SHARE', TG_ARGV[0])
    INTO v_status USING v_parent;

  -- Parent already gone = cascade delete of a draft.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Parent % is %; its rows cannot change', TG_ARGV[0], v_status
      USING ERRCODE = 'ERP03';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

-- =============================================================================
-- Audit trail
-- =============================================================================

-- Every insert/update/delete on business tables: who, when, from where, what.
CREATE TABLE audit.row_changes (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id      uuid,
  table_name     text        NOT NULL,
  record_id      text        NOT NULL,
  action         text        NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  changed_fields text[],
  old_data       jsonb,                    -- UPDATE: only the changed columns
  new_data       jsonb,
  user_id        uuid,                     -- application user (app.user_id)
  db_user        text        NOT NULL DEFAULT session_user,
  request_id     text,                     -- ties all changes of one API call together
  client_ip      inet,
  txid           bigint      NOT NULL DEFAULT pg_current_xact_id()::text::bigint,
  occurred_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX row_changes_record_idx ON audit.row_changes (tenant_id, table_name, record_id, occurred_at);
CREATE INDEX row_changes_user_idx   ON audit.row_changes (tenant_id, user_id, occurred_at);

-- Business events that are not row changes: login, failed login, print,
-- export, permission denied, ...
CREATE TABLE audit.events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid,
  user_id     uuid,
  event_type  text        NOT NULL,        -- e.g. 'auth.login', 'invoice.printed'
  entity_type text,
  entity_id   text,
  details     jsonb       NOT NULL DEFAULT '{}',
  request_id  text,
  client_ip   inet,
  user_agent  text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_tenant_idx ON audit.events (tenant_id, occurred_at);
CREATE INDEX events_user_idx   ON audit.events (user_id, occurred_at);

CREATE TRIGGER row_changes_append_only BEFORE UPDATE OR DELETE ON audit.row_changes
  FOR EACH ROW EXECUTE FUNCTION erp.forbid_change();
CREATE TRIGGER row_changes_no_truncate BEFORE TRUNCATE ON audit.row_changes
  FOR EACH STATEMENT EXECUTE FUNCTION erp.forbid_change();
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON audit.events
  FOR EACH ROW EXECUTE FUNCTION erp.forbid_change();
CREATE TRIGGER events_no_truncate BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION erp.forbid_change();

-- Attached as AFTER ... FOR EACH ROW. TG_ARGV = columns never to copy into the
-- log (e.g. password_hash).
CREATE FUNCTION audit.capture_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_old     jsonb;
  v_new     jsonb;
  v_hidden  text[] := coalesce(TG_ARGV, '{}');   -- TG_ARGV is NULL when no args are given
  v_full    jsonb;
  v_changed text[];
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD) - v_hidden; END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW) - v_hidden; END IF;
  v_full := coalesce(v_new, v_old);

  IF TG_OP = 'UPDATE' THEN
    v_changed := erp.changed_keys(v_old, v_new);
    IF v_changed = '{}' THEN
      RETURN NULL;                                   -- nothing really changed
    END IF;
    SELECT jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      INTO v_old, v_new
      FROM unnest(v_changed) k;
  END IF;

  INSERT INTO audit.row_changes
    (tenant_id, table_name, record_id, action, changed_fields, old_data, new_data,
     user_id, request_id, client_ip)
  VALUES
    (coalesce(v_full ->> 'tenant_id',
              CASE WHEN TG_TABLE_NAME = 'tenants' THEN v_full ->> 'id' END)::uuid,
     TG_TABLE_NAME, v_full ->> 'id', TG_OP, v_changed, v_old, v_new,
     erp.current_user_id(),
     nullif(current_setting('app.request_id', true), ''),
     nullif(current_setting('app.client_ip', true), '')::inet);
  RETURN NULL;
END $$;

-- Called by the API for business events. Failed logins must be logged in their
-- own transaction, otherwise a rollback would erase the evidence.
CREATE FUNCTION audit.log_event(
  p_event_type  text,
  p_entity_type text  DEFAULT NULL,
  p_entity_id   text  DEFAULT NULL,
  p_details     jsonb DEFAULT '{}',
  p_user_agent  text  DEFAULT NULL
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO audit.events
    (tenant_id, user_id, event_type, entity_type, entity_id, details,
     request_id, client_ip, user_agent)
  VALUES
    (erp.current_tenant_id(), erp.current_user_id(), p_event_type, p_entity_type,
     p_entity_id, coalesce(p_details, '{}'),
     nullif(current_setting('app.request_id', true), ''),
     nullif(current_setting('app.client_ip', true), '')::inet, p_user_agent)
$$;

RESET ROLE;
