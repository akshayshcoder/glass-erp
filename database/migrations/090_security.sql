-- =============================================================================
-- 005_security.sql
-- Tenant isolation (Row Level Security) and least-privilege grants.
--
-- Even if the API forgets a "WHERE tenant_id = ..." the database itself returns
-- only the current shop's rows. FORCE makes the rules apply to the table owner
-- too, so our SECURITY DEFINER functions are also tenant-bound.
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branches', 'product_categories', 'products', 'parties',
    'stock_balances', 'stock_movements', 'document_series',
    'sales_invoices', 'sales_invoice_lines', 'party_ledger',
    'receipts', 'receipt_allocations', 'gst_period_locks',
    'purchase_bills', 'purchase_bill_lines', 'supplier_payments', 'supplier_payment_allocations',
    'credit_notes', 'credit_note_lines', 'quotations', 'quotation_lines'] LOOP
    EXECUTE format('ALTER TABLE erp.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE erp.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON erp.%I
                      USING (tenant_id = erp.current_tenant_id())
                      WITH CHECK (tenant_id = erp.current_tenant_id())', t);
  END LOOP;
END $$;

-- Memberships: a user may see their own memberships in every shop (shop
-- switcher at login); changes are limited to the current shop.
ALTER TABLE erp.tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.tenant_members FORCE ROW LEVEL SECURITY;
CREATE POLICY own_memberships ON erp.tenant_members FOR SELECT
  USING (user_id = erp.current_user_id());
CREATE POLICY tenant_isolation ON erp.tenant_members
  USING (tenant_id = erp.current_tenant_id())
  WITH CHECK (tenant_id = erp.current_tenant_id());

ALTER TABLE erp.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY my_tenants ON erp.tenants FOR SELECT
  USING (id IN (SELECT tenant_id FROM erp.tenant_members WHERE user_id = erp.current_user_id()));
CREATE POLICY tenant_isolation ON erp.tenants
  USING (id = erp.current_tenant_id())
  WITH CHECK (id = erp.current_tenant_id());

-- Audit: shops read their own trail; nobody but the definer functions writes.
ALTER TABLE audit.row_changes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit.row_changes FOR SELECT
  USING (tenant_id = erp.current_tenant_id());
ALTER TABLE audit.events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON audit.events FOR SELECT
  USING (tenant_id = erp.current_tenant_id());

-- -----------------------------------------------------------------------------
-- Grants for the API role
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA erp, audit FROM PUBLIC;

GRANT SELECT ON ALL TABLES IN SCHEMA erp   TO erp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA audit TO erp_app;

-- Masters: create and edit, never delete (deactivate instead).
GRANT INSERT, UPDATE ON erp.users, erp.tenant_members, erp.branches,
                        erp.product_categories, erp.products, erp.parties TO erp_app;
GRANT UPDATE (name, legal_name, pan, settings) ON erp.tenants TO erp_app;
GRANT INSERT, UPDATE ON erp.user_sessions TO erp_app;
GRANT UPDATE (prefix, padding) ON erp.document_series TO erp_app;

-- Documents: drafts only (enforced by the guard triggers).
GRANT INSERT, UPDATE, DELETE ON erp.sales_invoices, erp.sales_invoice_lines,
                                erp.receipts, erp.receipt_allocations,
                                erp.purchase_bills, erp.purchase_bill_lines,
                                erp.supplier_payments, erp.supplier_payment_allocations,
                                erp.credit_notes, erp.credit_note_lines,
                                erp.quotations, erp.quotation_lines TO erp_app;

-- NOT granted on purpose: any write on stock_balances, stock_movements,
-- party_ledger, gst_period_locks, states, units, audit.*.
-- Those change only via the functions below.

-- Helpers used inside policies, defaults and triggers that run as the caller.
GRANT EXECUTE ON FUNCTION
  erp.current_tenant_id(), erp.current_user_id(), erp.require_tenant_id(),
  erp.today(), erp.financial_year_of(date), erp.is_owner_context(oid),
  erp.changed_keys(jsonb, jsonb), erp.require_role(text[])
TO erp_app;

-- Business API.
GRANT EXECUTE ON FUNCTION
  erp.register_tenant(text, text, text, char, text),
  erp.adjust_stock(uuid, uuid, numeric, text, boolean),
  erp.post_sales_invoice(uuid),
  erp.cancel_sales_invoice(uuid, text),
  erp.post_receipt(uuid),
  erp.cancel_receipt(uuid, text),
  erp.post_opening_balance(uuid, numeric, date),
  erp.post_purchase_bill(uuid),
  erp.cancel_purchase_bill(uuid, text),
  erp.post_supplier_payment(uuid),
  erp.cancel_supplier_payment(uuid, text),
  erp.post_credit_note(uuid),
  erp.cancel_credit_note(uuid, text),
  erp.issue_quotation(uuid),
  erp.set_quotation_response(uuid, boolean),
  erp.convert_quotation_to_invoice(uuid),
  erp.cancel_quotation(uuid, text),
  erp.lock_gst_period(uuid, text, text),
  erp.unlock_gst_period(uuid, text, text),
  audit.log_event(text, text, text, jsonb, text)
TO erp_app;

-- Internal on purpose: erp.apply_stock_movement, erp.next_document_number,
-- erp.assert_period_open.

RESET ROLE;
