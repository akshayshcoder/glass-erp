-- =============================================================================
-- 005_purchases.sql
-- Purchase bills (stock in + supplier ledger + ITC data) and supplier payments.
--
-- Same rules as sales: drafts are editable, posting is one atomic function,
-- posted documents are frozen, cancellation reverses everything.
-- Lock order: document -> bills (by id) -> stock (by product_id) -> products -> series
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

CREATE TABLE erp.purchase_bills (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id             uuid          NOT NULL,
  status                text          NOT NULL DEFAULT 'draft'
                                      CHECK (status IN ('draft', 'posted', 'cancelled')),
  doc_no                text,                         -- our number, e.g. MAINP2627/00001
  financial_year        text,
  entry_date            date          NOT NULL DEFAULT erp.today(),   -- goods received / booked
  supplier_id           uuid          NOT NULL,
  -- Supplier's own bill (needed for ITC matching with GSTR-2B)
  supplier_name         text          NOT NULL CHECK (btrim(supplier_name) <> ''),
  supplier_gstin        text          CHECK (supplier_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  supplier_invoice_no   text          NOT NULL CHECK (btrim(supplier_invoice_no) <> ''),
  supplier_invoice_date date          NOT NULL,
  supplier_invoice_fy   text          GENERATED ALWAYS AS (erp.financial_year_of(supplier_invoice_date)) STORED,
  supplier_state_code   char(2)       NOT NULL REFERENCES erp.states (code),
  buyer_state_code      char(2)       NOT NULL REFERENCES erp.states (code),
  reverse_charge        boolean       NOT NULL DEFAULT false,
  itc_eligible          boolean       NOT NULL DEFAULT true,
  taxable_value         numeric(14,2) NOT NULL DEFAULT 0 CHECK (taxable_value >= 0),
  cgst_amount           numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount           numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount           numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  round_off             numeric(4,2)  NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -1 AND 1),
  grand_total           numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid           numeric(14,2) NOT NULL DEFAULT 0,
  notes                 text,
  idempotency_key       text,
  posted_at             timestamptz,
  posted_by             uuid,
  cancelled_at          timestamptz,
  cancelled_by          uuid,
  cancel_reason         text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  updated_by            uuid,
  version               int           NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)   REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES erp.parties (tenant_id, id),
  CHECK (supplier_gstin IS NULL OR left(supplier_gstin, 2) = supplier_state_code),
  CHECK (CASE WHEN supplier_state_code <> buyer_state_code
              THEN cgst_amount = 0 AND sgst_amount = 0
              ELSE igst_amount = 0 AND cgst_amount = sgst_amount END),
  CHECK (grand_total = taxable_value + cgst_amount + sgst_amount + igst_amount + round_off),
  CHECK (amount_paid >= 0 AND amount_paid <= grand_total),
  CHECK (supplier_invoice_date <= entry_date),
  CHECK (status = 'draft' OR (doc_no IS NOT NULL AND financial_year IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
-- The same supplier bill can't be entered twice (very common mistake).
CREATE UNIQUE INDEX purchase_bills_supplier_bill_uq
  ON erp.purchase_bills (tenant_id, supplier_id, supplier_invoice_fy, upper(supplier_invoice_no))
  WHERE status <> 'cancelled';
CREATE UNIQUE INDEX purchase_bills_no_uq
  ON erp.purchase_bills (tenant_id, branch_id, financial_year, doc_no) WHERE doc_no IS NOT NULL;
CREATE UNIQUE INDEX purchase_bills_idem_uq
  ON erp.purchase_bills (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX purchase_bills_supplier_idx ON erp.purchase_bills (tenant_id, supplier_id, entry_date);
CREATE INDEX purchase_bills_date_idx     ON erp.purchase_bills (tenant_id, entry_date);

CREATE TABLE erp.purchase_bill_lines (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  bill_id         uuid          NOT NULL,
  line_no         smallint      NOT NULL CHECK (line_no > 0),
  product_id      uuid          NOT NULL,
  description     text          NOT NULL,
  hsn_code        text          NOT NULL CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  unit_code       text          NOT NULL REFERENCES erp.units (code),
  qty             numeric(14,3) NOT NULL CHECK (qty > 0),
  rate            numeric(14,4) NOT NULL CHECK (rate >= 0),
  discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  taxable_value   numeric(14,2) NOT NULL CHECK (taxable_value >= 0),
  gst_rate        numeric(5,2)  NOT NULL CHECK (gst_rate BETWEEN 0 AND 100),
  cgst_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount     numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  line_total      numeric(14,2) GENERATED ALWAYS AS
                    (taxable_value + cgst_amount + sgst_amount + igst_amount) STORED,
  UNIQUE (bill_id, line_no),
  FOREIGN KEY (tenant_id, bill_id)    REFERENCES erp.purchase_bills (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES erp.products (tenant_id, id),
  CHECK (cgst_amount = sgst_amount),
  CHECK (igst_amount = 0 OR cgst_amount = 0),
  CHECK (abs(cgst_amount + sgst_amount + igst_amount - taxable_value * gst_rate / 100) <= 0.02)
);
CREATE INDEX purchase_bill_lines_bill_idx    ON erp.purchase_bill_lines (tenant_id, bill_id);
CREATE INDEX purchase_bill_lines_product_idx ON erp.purchase_bill_lines (tenant_id, product_id);

-- ---------- Supplier payments ----------------------------------------------------
CREATE TABLE erp.supplier_payments (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id       uuid          NOT NULL,
  status          text          NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'posted', 'cancelled')),
  payment_no      text,
  financial_year  text,
  payment_date    date          NOT NULL DEFAULT erp.today(),
  supplier_id     uuid          NOT NULL,
  mode            text          NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque')),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  reference_no    text,
  notes           text,
  idempotency_key text,
  posted_at       timestamptz,
  posted_by       uuid,
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  cancel_reason   text,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz   NOT NULL DEFAULT now(),
  updated_by      uuid,
  version         int           NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)   REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES erp.parties (tenant_id, id),
  CHECK (status = 'draft' OR (payment_no IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
CREATE UNIQUE INDEX supplier_payments_no_uq
  ON erp.supplier_payments (tenant_id, branch_id, financial_year, payment_no) WHERE payment_no IS NOT NULL;
CREATE UNIQUE INDEX supplier_payments_idem_uq
  ON erp.supplier_payments (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX supplier_payments_supplier_idx ON erp.supplier_payments (tenant_id, supplier_id, payment_date);

CREATE TABLE erp.supplier_payment_allocations (
  id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  payment_id uuid          NOT NULL,
  bill_id    uuid          NOT NULL,
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  UNIQUE (payment_id, bill_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES erp.supplier_payments (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, bill_id)    REFERENCES erp.purchase_bills (tenant_id, id)
);
CREATE INDEX supplier_payment_allocations_bill_idx ON erp.supplier_payment_allocations (tenant_id, bill_id);

-- ---------- Triggers -------------------------------------------------------------
CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.purchase_bills
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document(
    'doc_no,financial_year,amount_paid,posted_at,posted_by,cancelled_at,cancelled_by,cancel_reason',
    'amount_paid,cancelled_at,cancelled_by,cancel_reason');
CREATE TRIGGER t20_stamp BEFORE INSERT OR UPDATE ON erp.purchase_bills
  FOR EACH ROW EXECUTE FUNCTION erp.stamp_row();
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.purchase_bills
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.purchase_bill_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document_child('purchase_bills', 'bill_id');
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.purchase_bill_lines
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document(
    'payment_no,financial_year,posted_at,posted_by,cancelled_at,cancelled_by,cancel_reason',
    'cancelled_at,cancelled_by,cancel_reason');
CREATE TRIGGER t20_stamp BEFORE INSERT OR UPDATE ON erp.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION erp.stamp_row();
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document_child('supplier_payments', 'payment_id');
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

-- =============================================================================
-- Business functions
-- =============================================================================

CREATE FUNCTION erp.post_purchase_bill(p_bill_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  b        erp.purchase_bills%ROWTYPE;
  br       erp.branches%ROWTYPE;
  tot      record;
  r        record;
  v_no     text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'storekeeper');

  SELECT * INTO b FROM erp.purchase_bills WHERE tenant_id = v_tenant AND id = p_bill_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase bill % not found', p_bill_id USING ERRCODE = 'ERP04';
  END IF;
  IF b.status = 'posted' THEN
    RETURN b.doc_no;
  END IF;
  IF b.status <> 'draft' THEN
    RAISE EXCEPTION 'Purchase bill is %', b.status USING ERRCODE = 'ERP02';
  END IF;
  IF b.entry_date > erp.today() THEN
    RAISE EXCEPTION 'Entry date cannot be in the future' USING ERRCODE = 'ERP04';
  END IF;

  SELECT * INTO br FROM erp.branches WHERE tenant_id = v_tenant AND id = b.branch_id;
  IF NOT br.is_active OR br.state_code <> b.buyer_state_code THEN
    RAISE EXCEPTION 'Buyer state on the bill does not match the branch' USING ERRCODE = 'ERP04';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM erp.parties WHERE tenant_id = v_tenant AND id = b.supplier_id
                   AND kind IN ('supplier', 'both')) THEN
    RAISE EXCEPTION 'Party is not a supplier' USING ERRCODE = 'ERP04';
  END IF;
  PERFORM erp.assert_period_open(b.branch_id, b.entry_date);

  SELECT count(*) AS n,
         coalesce(sum(taxable_value), 0) AS tv, coalesce(sum(cgst_amount), 0) AS c,
         coalesce(sum(sgst_amount), 0)   AS s,  coalesce(sum(igst_amount), 0) AS i
    INTO tot
    FROM erp.purchase_bill_lines WHERE tenant_id = v_tenant AND bill_id = b.id;
  IF tot.n = 0 THEN
    RAISE EXCEPTION 'Purchase bill has no lines' USING ERRCODE = 'ERP04';
  END IF;
  IF (tot.tv, tot.c, tot.s, tot.i)
     IS DISTINCT FROM (b.taxable_value, b.cgst_amount, b.sgst_amount, b.igst_amount) THEN
    RAISE EXCEPTION 'Bill totals do not match its lines' USING ERRCODE = 'ERP04';
  END IF;

  FOR r IN
    SELECT l.product_id, sum(l.qty) AS qty, sum(l.taxable_value) AS cost, bool_or(p.track_inventory) AS tracked
    FROM erp.purchase_bill_lines l
    JOIN erp.products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
    WHERE l.tenant_id = v_tenant AND l.bill_id = b.id
    GROUP BY l.product_id
    ORDER BY l.product_id
  LOOP
    IF r.tracked THEN
      PERFORM erp.apply_stock_movement(b.branch_id, r.product_id, 'purchase', r.qty, 'purchase_bill', b.id);
    END IF;
    -- Last purchase price (net of discount, before tax), used for margin reports.
    UPDATE erp.products SET purchase_price = round(r.cost / r.qty, 4)
    WHERE tenant_id = v_tenant AND id = r.product_id;
  END LOOP;

  v_no := erp.next_document_number(b.branch_id, 'purchase', b.entry_date);

  IF b.grand_total > 0 THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, credit, narration)
    VALUES
      (v_tenant, b.supplier_id, b.branch_id, b.entry_date, 'purchase', b.id, v_no, b.grand_total,
       'Purchase ' || v_no || ' (supplier bill ' || b.supplier_invoice_no || ')');
  END IF;

  UPDATE erp.purchase_bills
     SET status = 'posted', doc_no = v_no, financial_year = erp.financial_year_of(b.entry_date),
         posted_at = now(), posted_by = erp.current_user_id()
   WHERE id = b.id;
  RETURN v_no;
END $$;

-- Wrong bill entered: take the stock back out and reverse the supplier ledger.
-- Fails if the goods were already sold (stock would go negative).
CREATE FUNCTION erp.cancel_purchase_bill(p_bill_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  b        erp.purchase_bills%ROWTYPE;
  r        record;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required' USING ERRCODE = 'ERP04';
  END IF;

  SELECT * INTO b FROM erp.purchase_bills WHERE tenant_id = v_tenant AND id = p_bill_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase bill % not found', p_bill_id USING ERRCODE = 'ERP04';
  END IF;
  IF b.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted bills can be cancelled (this one is %)', b.status USING ERRCODE = 'ERP02';
  END IF;
  IF b.amount_paid > 0 THEN
    RAISE EXCEPTION 'Bill has payments of %; cancel those first', b.amount_paid USING ERRCODE = 'ERP02';
  END IF;
  PERFORM erp.assert_period_open(b.branch_id, b.entry_date);

  FOR r IN
    SELECT product_id, sum(qty_change) AS qty
    FROM erp.stock_movements
    WHERE tenant_id = v_tenant AND ref_type = 'purchase_bill' AND ref_id = b.id AND movement_type = 'purchase'
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    PERFORM erp.apply_stock_movement(b.branch_id, r.product_id, 'purchase_cancel', -r.qty,
                                     'purchase_bill', b.id, p_reason);
  END LOOP;

  IF b.grand_total > 0 THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, debit, narration)
    VALUES
      (v_tenant, b.supplier_id, b.branch_id, erp.today(), 'purchase_cancel', b.id, b.doc_no,
       b.grand_total, 'Cancelled: ' || p_reason);
  END IF;

  UPDATE erp.purchase_bills
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = erp.current_user_id(),
         cancel_reason = p_reason
   WHERE id = b.id;
END $$;

CREATE FUNCTION erp.post_supplier_payment(p_payment_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant    uuid := erp.require_tenant_id();
  pm          erp.supplier_payments%ROWTYPE;
  b           erp.purchase_bills%ROWTYPE;
  a           record;
  v_allocated numeric(14,2);
  v_no        text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager');

  SELECT * INTO pm FROM erp.supplier_payments WHERE tenant_id = v_tenant AND id = p_payment_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', p_payment_id USING ERRCODE = 'ERP04';
  END IF;
  IF pm.status = 'posted' THEN
    RETURN pm.payment_no;
  END IF;
  IF pm.status <> 'draft' THEN
    RAISE EXCEPTION 'Payment is %', pm.status USING ERRCODE = 'ERP02';
  END IF;
  IF pm.payment_date > erp.today() THEN
    RAISE EXCEPTION 'Payment date cannot be in the future' USING ERRCODE = 'ERP04';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_allocated
  FROM erp.supplier_payment_allocations WHERE tenant_id = v_tenant AND payment_id = pm.id;
  IF v_allocated > pm.amount THEN
    RAISE EXCEPTION 'Allocated % is more than the paid %', v_allocated, pm.amount USING ERRCODE = 'ERP04';
  END IF;

  FOR a IN
    SELECT bill_id, amount FROM erp.supplier_payment_allocations
    WHERE tenant_id = v_tenant AND payment_id = pm.id
    ORDER BY bill_id
  LOOP
    SELECT * INTO b FROM erp.purchase_bills WHERE tenant_id = v_tenant AND id = a.bill_id FOR NO KEY UPDATE;
    IF b.status <> 'posted' THEN
      RAISE EXCEPTION 'Bill % is %, payments need a posted bill', b.id, b.status USING ERRCODE = 'ERP02';
    END IF;
    IF b.supplier_id <> pm.supplier_id THEN
      RAISE EXCEPTION 'Bill % belongs to another supplier', b.doc_no USING ERRCODE = 'ERP04';
    END IF;
    IF b.amount_paid + a.amount > b.grand_total THEN
      RAISE EXCEPTION 'Payment exceeds the balance of bill %', b.doc_no
        USING ERRCODE = 'ERP04',
              DETAIL = format('balance=%s payment=%s', b.grand_total - b.amount_paid, a.amount);
    END IF;
    UPDATE erp.purchase_bills SET amount_paid = amount_paid + a.amount WHERE id = b.id;
  END LOOP;

  v_no := erp.next_document_number(pm.branch_id, 'supplier_payment', pm.payment_date);

  INSERT INTO erp.party_ledger
    (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, debit, narration)
  VALUES
    (v_tenant, pm.supplier_id, pm.branch_id, pm.payment_date, 'supplier_payment', pm.id, v_no, pm.amount,
     'Payment ' || v_no || ' (' || pm.mode || ')');

  UPDATE erp.supplier_payments
     SET status = 'posted', payment_no = v_no, financial_year = erp.financial_year_of(pm.payment_date),
         posted_at = now(), posted_by = erp.current_user_id()
   WHERE id = pm.id;
  RETURN v_no;
END $$;

CREATE FUNCTION erp.cancel_supplier_payment(p_payment_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  pm       erp.supplier_payments%ROWTYPE;
  a        record;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required' USING ERRCODE = 'ERP04';
  END IF;

  SELECT * INTO pm FROM erp.supplier_payments WHERE tenant_id = v_tenant AND id = p_payment_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment % not found', p_payment_id USING ERRCODE = 'ERP04';
  END IF;
  IF pm.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted payments can be cancelled (this one is %)', pm.status USING ERRCODE = 'ERP02';
  END IF;

  FOR a IN
    SELECT bill_id, amount FROM erp.supplier_payment_allocations
    WHERE tenant_id = v_tenant AND payment_id = pm.id
    ORDER BY bill_id
  LOOP
    UPDATE erp.purchase_bills SET amount_paid = amount_paid - a.amount
    WHERE tenant_id = v_tenant AND id = a.bill_id;
  END LOOP;

  INSERT INTO erp.party_ledger
    (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, credit, narration)
  VALUES
    (v_tenant, pm.supplier_id, pm.branch_id, erp.today(), 'supplier_payment_cancel', pm.id, pm.payment_no,
     pm.amount, 'Cancelled: ' || p_reason);

  UPDATE erp.supplier_payments
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = erp.current_user_id(),
         cancel_reason = p_reason
   WHERE id = pm.id;
END $$;

CREATE VIEW erp.v_purchase_outstanding WITH (security_invoker = true) AS
SELECT b.tenant_id, b.id AS bill_id, b.branch_id, b.doc_no, b.entry_date, b.supplier_id, b.supplier_name,
       b.supplier_invoice_no, b.supplier_invoice_date, b.grand_total, b.amount_paid,
       b.grand_total - b.amount_paid AS balance_due
FROM erp.purchase_bills b
WHERE b.status = 'posted';

RESET ROLE;
