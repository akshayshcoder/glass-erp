-- =============================================================================
-- 096_advance_wallet_fifo.sql
-- Advance payment tracking, customer wallet balance, and FIFO knockoff settlement
-- between customer advance receipts and sales invoices.
-- =============================================================================

SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

-- ---------- Advance allocations (settling invoices from posted receipts) ------
CREATE TABLE IF NOT EXISTS erp.advance_allocations (
  id          uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  receipt_id  uuid          NOT NULL,
  invoice_id  uuid          NOT NULL,
  amount      numeric(14,2) NOT NULL CHECK (amount > 0),
  notes       text,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  created_by  uuid          DEFAULT erp.current_user_id(),
  UNIQUE (tenant_id, receipt_id, invoice_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES erp.receipts (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp.sales_invoices (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS advance_alloc_receipt_idx ON erp.advance_allocations (tenant_id, receipt_id);
CREATE INDEX IF NOT EXISTS advance_alloc_invoice_idx ON erp.advance_allocations (tenant_id, invoice_id);

ALTER TABLE erp.advance_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE erp.advance_allocations FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'erp' AND tablename = 'advance_allocations' AND policyname = 'tenant_isolation'
  ) THEN
    CREATE POLICY tenant_isolation ON erp.advance_allocations
      USING (tenant_id = erp.current_tenant_id())
      WITH CHECK (tenant_id = erp.current_tenant_id());
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON erp.advance_allocations TO erp_app;

-- Audit trail for advance allocations
DROP TRIGGER IF EXISTS t90_audit ON erp.advance_allocations;
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.advance_allocations
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

-- ---------- Helper Views -----------------------------------------------------

-- View: Receipts with total allocated (initial + post-receipt advance allocations)
-- and unallocated advance remaining.
CREATE OR REPLACE VIEW erp.v_receipt_advance WITH (security_invoker = true) AS
WITH init_alloc AS (
  SELECT receipt_id, coalesce(sum(amount), 0) AS initial_amount
  FROM erp.receipt_allocations
  GROUP BY receipt_id
),
adv_alloc AS (
  SELECT receipt_id, coalesce(sum(amount), 0) AS advance_amount
  FROM erp.advance_allocations
  GROUP BY receipt_id
)
SELECT r.tenant_id,
       r.id AS receipt_id,
       r.branch_id,
       r.receipt_no,
       r.receipt_date,
       r.party_id,
       r.mode,
       r.amount,
       coalesce(ia.initial_amount, 0) + coalesce(aa.advance_amount, 0) AS total_allocated,
       r.amount - (coalesce(ia.initial_amount, 0) + coalesce(aa.advance_amount, 0)) AS unallocated_amount
FROM erp.receipts r
LEFT JOIN init_alloc ia ON ia.receipt_id = r.id
LEFT JOIN adv_alloc aa  ON aa.receipt_id = r.id
WHERE r.status = 'posted' AND r.party_id IS NOT NULL;

-- View: Customer Wallet (Total Unallocated Advance per Party)
CREATE OR REPLACE VIEW erp.v_customer_wallet WITH (security_invoker = true) AS
SELECT tenant_id,
       party_id,
       count(*) AS unallocated_receipts_count,
       coalesce(sum(unallocated_amount), 0) AS wallet_balance
FROM erp.v_receipt_advance
WHERE unallocated_amount > 0
GROUP BY tenant_id, party_id;

-- View: 360-degree Customer Credit & Outstanding Exposure
CREATE OR REPLACE VIEW erp.v_customer_exposure WITH (security_invoker = true) AS
WITH unpaid_inv AS (
  SELECT tenant_id,
         party_id,
         count(*) AS unpaid_invoices_count,
         coalesce(sum(balance_due), 0) AS total_outstanding,
         min(invoice_date) AS oldest_invoice_date
  FROM erp.v_invoice_outstanding
  WHERE party_id IS NOT NULL AND balance_due > 0
  GROUP BY tenant_id, party_id
),
wallets AS (
  SELECT tenant_id, party_id, wallet_balance
  FROM erp.v_customer_wallet
)
SELECT p.tenant_id,
       p.id AS party_id,
       p.name AS party_name,
       p.phone,
       p.gstin,
       p.credit_limit,
       p.credit_days,
       coalesce(b.balance, 0) AS ledger_balance,
       coalesce(ui.total_outstanding, 0) AS total_outstanding,
       coalesce(w.wallet_balance, 0) AS wallet_balance,
       coalesce(ui.unpaid_invoices_count, 0) AS unpaid_invoices_count,
       ui.oldest_invoice_date,
       CASE WHEN p.credit_limit > 0
            THEN p.credit_limit - coalesce(ui.total_outstanding, 0) + coalesce(w.wallet_balance, 0)
            ELSE NULL
       END AS available_credit
FROM erp.parties p
LEFT JOIN erp.v_party_balances b ON b.party_id = p.id
LEFT JOIN unpaid_inv ui          ON ui.party_id = p.id
LEFT JOIN wallets w              ON w.party_id = p.id
WHERE p.kind IN ('customer', 'both');

-- ---------- Business Functions -----------------------------------------------

-- 1. Apply advance from customer's wallet to a specific invoice
CREATE OR REPLACE FUNCTION erp.apply_advance_to_invoice(
  p_invoice_id uuid,
  p_amount numeric DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant       uuid := erp.require_tenant_id();
  v_inv          erp.sales_invoices%ROWTYPE;
  v_balance_due  numeric(14,2);
  v_to_apply     numeric(14,2);
  v_rc           record;
  v_alloc        numeric(14,2);
  v_total_applied numeric(14,2) := 0;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');

  -- Lock invoice
  SELECT * INTO v_inv FROM erp.sales_invoices
  WHERE tenant_id = v_tenant AND id = p_invoice_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id USING ERRCODE = 'ERP04';
  END IF;
  IF v_inv.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted invoices can receive settlements' USING ERRCODE = 'ERP02';
  END IF;
  IF v_inv.party_id IS NULL THEN
    RAISE EXCEPTION 'Walk-in invoices cannot receive advance settlement' USING ERRCODE = 'ERP04';
  END IF;

  v_balance_due := v_inv.grand_total - v_inv.amount_credited - v_inv.amount_paid;
  IF v_balance_due <= 0 THEN
    RAISE EXCEPTION 'Invoice % is already fully paid', v_inv.invoice_no USING ERRCODE = 'ERP04';
  END IF;

  v_to_apply := coalesce(p_amount, v_balance_due);
  IF v_to_apply <= 0 THEN
    RAISE EXCEPTION 'Amount to apply must be positive' USING ERRCODE = 'ERP04';
  END IF;
  IF v_to_apply > v_balance_due THEN
    v_to_apply := v_balance_due;
  END IF;

  -- Find posted receipts for this customer with unallocated advance in FIFO order
  FOR v_rc IN
    SELECT r.id AS receipt_id,
           r.receipt_no,
           ra.unallocated_amount
    FROM erp.v_receipt_advance ra
    JOIN erp.receipts r ON r.id = ra.receipt_id
    WHERE ra.tenant_id = v_tenant
      AND ra.party_id = v_inv.party_id
      AND ra.unallocated_amount > 0
    ORDER BY r.receipt_date ASC, r.created_at ASC
    FOR NO KEY UPDATE OF r
  LOOP
    EXIT WHEN v_to_apply <= 0;

    v_alloc := least(v_to_apply, v_rc.unallocated_amount);
    IF v_alloc > 0 THEN
      INSERT INTO erp.advance_allocations (tenant_id, receipt_id, invoice_id, amount, notes)
      VALUES (v_tenant, v_rc.receipt_id, v_inv.id, v_alloc, 'Advance from ' || v_rc.receipt_no)
      ON CONFLICT (tenant_id, receipt_id, invoice_id)
      DO UPDATE SET amount = erp.advance_allocations.amount + EXCLUDED.amount;

      v_to_apply := v_to_apply - v_alloc;
      v_total_applied := v_total_applied + v_alloc;
    END IF;
  END LOOP;

  IF v_total_applied > 0 THEN
    UPDATE erp.sales_invoices
       SET amount_paid = amount_paid + v_total_applied
     WHERE id = v_inv.id;
  END IF;

  RETURN v_total_applied;
END $$;

-- 2. FIFO Auto-Knockoff across all customer's advance receipts and unpaid invoices
CREATE OR REPLACE FUNCTION erp.settle_customer_fifo(
  p_party_id uuid,
  p_max_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant         uuid := erp.require_tenant_id();
  v_max            numeric(14,2) := coalesce(p_max_amount, 999999999.99);
  v_rc_record      record;
  v_inv_record     record;
  v_rc_balance     numeric(14,2);
  v_inv_balance    numeric(14,2);
  v_alloc          numeric(14,2);
  v_total_settled  numeric(14,2) := 0;
  v_invoices_count int := 0;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');

  IF NOT EXISTS (SELECT 1 FROM erp.parties WHERE tenant_id = v_tenant AND id = p_party_id) THEN
    RAISE EXCEPTION 'Customer % not found', p_party_id USING ERRCODE = 'ERP04';
  END IF;

  -- Loop through all unallocated posted receipts (FIFO: oldest first)
  FOR v_rc_record IN
    SELECT r.id AS receipt_id,
           r.receipt_no,
           ra.unallocated_amount
    FROM erp.v_receipt_advance ra
    JOIN erp.receipts r ON r.id = ra.receipt_id
    WHERE ra.tenant_id = v_tenant
      AND ra.party_id = p_party_id
      AND ra.unallocated_amount > 0
    ORDER BY r.receipt_date ASC, r.created_at ASC
    FOR NO KEY UPDATE OF r
  LOOP
    EXIT WHEN v_max <= 0;
    v_rc_balance := least(v_rc_record.unallocated_amount, v_max);

    -- Loop through all unpaid posted sales invoices (FIFO: oldest first)
    FOR v_inv_record IN
      SELECT id, invoice_no, (grand_total - amount_credited - amount_paid) AS balance_due
      FROM erp.sales_invoices
      WHERE tenant_id = v_tenant
        AND party_id = p_party_id
        AND status = 'posted'
        AND (grand_total - amount_credited - amount_paid) > 0
      ORDER BY invoice_date ASC, created_at ASC
      FOR NO KEY UPDATE
    LOOP
      EXIT WHEN v_rc_balance <= 0 OR v_max <= 0;

      v_inv_balance := v_inv_record.balance_due;
      v_alloc := least(v_rc_balance, v_inv_balance, v_max);

      IF v_alloc > 0 THEN
        INSERT INTO erp.advance_allocations (tenant_id, receipt_id, invoice_id, amount, notes)
        VALUES (v_tenant, v_rc_record.receipt_id, v_inv_record.id, v_alloc, 'FIFO Knockoff: ' || v_rc_record.receipt_no)
        ON CONFLICT (tenant_id, receipt_id, invoice_id)
        DO UPDATE SET amount = erp.advance_allocations.amount + EXCLUDED.amount;

        UPDATE erp.sales_invoices
           SET amount_paid = amount_paid + v_alloc
         WHERE id = v_inv_record.id;

        v_rc_balance := v_rc_balance - v_alloc;
        v_max := v_max - v_alloc;
        v_total_settled := v_total_settled + v_alloc;
        v_invoices_count := v_invoices_count + 1;
      END IF;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'partyId', p_party_id,
    'totalSettled', v_total_settled,
    'invoicesCount', v_invoices_count
  );
END $$;

GRANT SELECT ON erp.v_receipt_advance, erp.v_customer_wallet, erp.v_customer_exposure TO erp_app;
GRANT EXECUTE ON FUNCTION erp.apply_advance_to_invoice(uuid, numeric) TO erp_app;
GRANT EXECUTE ON FUNCTION erp.settle_customer_fifo(uuid, numeric) TO erp_app;

RESET ROLE;
