-- =============================================================================
-- 006_credit_notes.sql
-- Credit notes against a posted sales invoice:
--   * sales_return    : goods came back (optionally back into stock)
--   * rate_difference / discount / deficiency / other : value correction only
-- This is also how invoices are corrected after their GST month is filed.
--
-- GST rules enforced:
--   * must reference the original invoice; same customer, same place of supply
--   * issued no later than 30 November after the invoice's financial year
--   * total credited can't exceed the invoice; returned qty can't exceed sold qty
-- Lock order: credit note -> invoice -> stock (by product_id) -> series
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

CREATE TABLE erp.credit_notes (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id         uuid          NOT NULL,
  status            text          NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'posted', 'cancelled')),
  note_no           text,
  financial_year    text,
  note_date         date          NOT NULL DEFAULT erp.today(),
  invoice_id        uuid          NOT NULL,
  party_id          uuid,
  reason            text          NOT NULL CHECK (reason IN
                      ('sales_return', 'rate_difference', 'discount', 'deficiency', 'other')),
  restock           boolean       NOT NULL DEFAULT false,   -- returned goods are saleable
  customer_name     text          NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_gstin    text          CHECK (customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  place_of_supply   char(2)       NOT NULL REFERENCES erp.states (code),
  seller_state_code char(2)       NOT NULL REFERENCES erp.states (code),
  seller_gstin      text,
  taxable_value     numeric(14,2) NOT NULL DEFAULT 0 CHECK (taxable_value >= 0),
  cgst_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  round_off         numeric(4,2)  NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -1 AND 1),
  grand_total       numeric(14,2) NOT NULL DEFAULT 0 CHECK (grand_total >= 0),
  remarks           text,
  idempotency_key   text,
  posted_at         timestamptz,
  posted_by         uuid,
  cancelled_at      timestamptz,
  cancelled_by      uuid,
  cancel_reason     text,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  updated_by        uuid,
  version           int           NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp.sales_invoices (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id)   REFERENCES erp.parties (tenant_id, id),
  CHECK (reason = 'sales_return' OR NOT restock),
  CHECK (CASE WHEN place_of_supply <> seller_state_code
              THEN cgst_amount = 0 AND sgst_amount = 0
              ELSE igst_amount = 0 AND cgst_amount = sgst_amount END),
  CHECK (grand_total = taxable_value + cgst_amount + sgst_amount + igst_amount + round_off),
  CHECK (status = 'draft' OR (note_no IS NOT NULL AND financial_year IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
CREATE UNIQUE INDEX credit_notes_no_uq
  ON erp.credit_notes (tenant_id, branch_id, financial_year, note_no) WHERE note_no IS NOT NULL;
CREATE UNIQUE INDEX credit_notes_idem_uq
  ON erp.credit_notes (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX credit_notes_invoice_idx ON erp.credit_notes (tenant_id, invoice_id);
CREATE INDEX credit_notes_date_idx    ON erp.credit_notes (tenant_id, note_date);

CREATE TABLE erp.credit_note_lines (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  credit_note_id uuid          NOT NULL,
  line_no        smallint      NOT NULL CHECK (line_no > 0),
  product_id     uuid          NOT NULL,
  description    text          NOT NULL,
  hsn_code       text          NOT NULL CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  unit_code      text          NOT NULL REFERENCES erp.units (code),
  qty            numeric(14,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),   -- 0 for value-only notes
  rate           numeric(14,4) NOT NULL DEFAULT 0 CHECK (rate >= 0),
  taxable_value  numeric(14,2) NOT NULL CHECK (taxable_value > 0),
  gst_rate       numeric(5,2)  NOT NULL CHECK (gst_rate BETWEEN 0 AND 100),
  cgst_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  line_total     numeric(14,2) GENERATED ALWAYS AS
                   (taxable_value + cgst_amount + sgst_amount + igst_amount) STORED,
  UNIQUE (credit_note_id, line_no),
  FOREIGN KEY (tenant_id, credit_note_id) REFERENCES erp.credit_notes (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)     REFERENCES erp.products (tenant_id, id),
  CHECK (cgst_amount = sgst_amount),
  CHECK (igst_amount = 0 OR cgst_amount = 0),
  CHECK (abs(cgst_amount + sgst_amount + igst_amount - taxable_value * gst_rate / 100) <= 0.02)
);
CREATE INDEX credit_note_lines_note_idx ON erp.credit_note_lines (tenant_id, credit_note_id);

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.credit_notes
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document(
    'note_no,financial_year,seller_gstin,posted_at,posted_by,cancelled_at,cancelled_by,cancel_reason',
    'cancelled_at,cancelled_by,cancel_reason');
CREATE TRIGGER t20_stamp BEFORE INSERT OR UPDATE ON erp.credit_notes
  FOR EACH ROW EXECUTE FUNCTION erp.stamp_row();
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.credit_notes
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document_child('credit_notes', 'credit_note_id');
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

-- =============================================================================
CREATE FUNCTION erp.post_credit_note(p_credit_note_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant   uuid := erp.require_tenant_id();
  cn         erp.credit_notes%ROWTYPE;
  inv        erp.sales_invoices%ROWTYPE;
  tot        record;
  r          record;
  v_deadline date;
  v_no       text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager');

  SELECT * INTO cn FROM erp.credit_notes WHERE tenant_id = v_tenant AND id = p_credit_note_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note % not found', p_credit_note_id USING ERRCODE = 'ERP04';
  END IF;
  IF cn.status = 'posted' THEN
    RETURN cn.note_no;
  END IF;
  IF cn.status <> 'draft' THEN
    RAISE EXCEPTION 'Credit note is %', cn.status USING ERRCODE = 'ERP02';
  END IF;
  IF cn.note_date > erp.today() THEN
    RAISE EXCEPTION 'Credit note date cannot be in the future' USING ERRCODE = 'ERP04';
  END IF;

  -- Lock the invoice: two credit notes on the same invoice are applied one by one.
  SELECT * INTO inv FROM erp.sales_invoices WHERE tenant_id = v_tenant AND id = cn.invoice_id FOR NO KEY UPDATE;
  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'Credit notes need a posted invoice (this one is %)', inv.status USING ERRCODE = 'ERP02';
  END IF;
  IF cn.branch_id <> inv.branch_id
     OR cn.party_id IS DISTINCT FROM inv.party_id
     OR cn.customer_gstin IS DISTINCT FROM inv.customer_gstin
     OR cn.place_of_supply <> inv.place_of_supply
     OR cn.seller_state_code <> inv.seller_state_code THEN
    RAISE EXCEPTION 'Credit note must match the invoice''s branch, customer and place of supply'
      USING ERRCODE = 'ERP04';
  END IF;
  IF cn.note_date < inv.invoice_date THEN
    RAISE EXCEPTION 'Credit note cannot be dated before its invoice' USING ERRCODE = 'ERP04';
  END IF;
  v_deadline := make_date(split_part(inv.financial_year, '-', 1)::int + 1, 11, 30);
  IF cn.note_date > v_deadline THEN
    RAISE EXCEPTION 'GST time limit passed: credit notes for FY % must be issued by %',
      inv.financial_year, v_deadline USING ERRCODE = 'ERP04';
  END IF;
  PERFORM erp.assert_period_open(cn.branch_id, cn.note_date);

  SELECT count(*) AS n,
         coalesce(sum(taxable_value), 0) AS tv, coalesce(sum(cgst_amount), 0) AS c,
         coalesce(sum(sgst_amount), 0)   AS s,  coalesce(sum(igst_amount), 0) AS i
    INTO tot
    FROM erp.credit_note_lines WHERE tenant_id = v_tenant AND credit_note_id = cn.id;
  IF tot.n = 0 THEN
    RAISE EXCEPTION 'Credit note has no lines' USING ERRCODE = 'ERP04';
  END IF;
  IF (tot.tv, tot.c, tot.s, tot.i)
     IS DISTINCT FROM (cn.taxable_value, cn.cgst_amount, cn.sgst_amount, cn.igst_amount) THEN
    RAISE EXCEPTION 'Credit note totals do not match its lines' USING ERRCODE = 'ERP04';
  END IF;
  IF inv.amount_credited + cn.grand_total > inv.grand_total THEN
    RAISE EXCEPTION 'Credit exceeds the invoice value' USING ERRCODE = 'ERP04',
      DETAIL = format('invoice=%s already credited=%s this note=%s',
                      inv.grand_total, inv.amount_credited, cn.grand_total);
  END IF;

  -- Every line must be a product (at the same GST rate) that is on the invoice.
  IF EXISTS (
    SELECT 1 FROM erp.credit_note_lines l
    WHERE l.tenant_id = v_tenant AND l.credit_note_id = cn.id
      AND NOT EXISTS (SELECT 1 FROM erp.sales_invoice_lines il
                      WHERE il.tenant_id = v_tenant AND il.invoice_id = inv.id
                        AND il.product_id = l.product_id AND il.gst_rate = l.gst_rate)) THEN
    RAISE EXCEPTION 'Credit note has a product / GST rate that is not on the invoice' USING ERRCODE = 'ERP04';
  END IF;

  IF cn.reason = 'sales_return' THEN
    IF EXISTS (SELECT 1 FROM erp.credit_note_lines WHERE tenant_id = v_tenant
                 AND credit_note_id = cn.id AND qty = 0) THEN
      RAISE EXCEPTION 'Every line of a sales return needs a quantity' USING ERRCODE = 'ERP04';
    END IF;
    -- Returned so far (posted returns) + this note <= sold, per product.
    IF EXISTS (
      SELECT 1
      FROM (SELECT product_id, sum(qty) AS qty FROM erp.credit_note_lines
            WHERE tenant_id = v_tenant AND credit_note_id = cn.id GROUP BY product_id) this_note
      LEFT JOIN (SELECT l.product_id, sum(l.qty) AS qty
                 FROM erp.credit_note_lines l
                 JOIN erp.credit_notes c ON c.tenant_id = l.tenant_id AND c.id = l.credit_note_id
                 WHERE c.tenant_id = v_tenant AND c.invoice_id = inv.id
                   AND c.status = 'posted' AND c.reason = 'sales_return'
                 GROUP BY l.product_id) earlier USING (product_id)
      LEFT JOIN (SELECT product_id, sum(qty) AS qty FROM erp.sales_invoice_lines
                 WHERE tenant_id = v_tenant AND invoice_id = inv.id GROUP BY product_id) sold USING (product_id)
      WHERE this_note.qty + coalesce(earlier.qty, 0) > coalesce(sold.qty, 0)) THEN
      RAISE EXCEPTION 'Returned quantity exceeds the quantity sold on the invoice' USING ERRCODE = 'ERP04';
    END IF;
  END IF;

  IF cn.restock THEN
    FOR r IN
      SELECT l.product_id, sum(l.qty) AS qty
      FROM erp.credit_note_lines l
      JOIN erp.products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
      WHERE l.tenant_id = v_tenant AND l.credit_note_id = cn.id AND p.track_inventory
      GROUP BY l.product_id
      ORDER BY l.product_id
    LOOP
      PERFORM erp.apply_stock_movement(cn.branch_id, r.product_id, 'sale_return', r.qty, 'credit_note', cn.id);
    END LOOP;
  END IF;

  v_no := erp.next_document_number(cn.branch_id, 'credit_note', cn.note_date);

  IF cn.party_id IS NOT NULL AND cn.grand_total > 0 THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, credit, narration)
    VALUES
      (v_tenant, cn.party_id, cn.branch_id, cn.note_date, 'credit_note', cn.id, v_no, cn.grand_total,
       'Credit note ' || v_no || ' against ' || inv.invoice_no);
  END IF;

  UPDATE erp.sales_invoices SET amount_credited = amount_credited + cn.grand_total WHERE id = inv.id;

  UPDATE erp.credit_notes
     SET status = 'posted', note_no = v_no, financial_year = erp.financial_year_of(cn.note_date),
         seller_gstin = inv.seller_gstin, posted_at = now(), posted_by = erp.current_user_id()
   WHERE id = cn.id;
  RETURN v_no;
END $$;

CREATE FUNCTION erp.cancel_credit_note(p_credit_note_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  cn       erp.credit_notes%ROWTYPE;
  r        record;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required' USING ERRCODE = 'ERP04';
  END IF;

  SELECT * INTO cn FROM erp.credit_notes WHERE tenant_id = v_tenant AND id = p_credit_note_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Credit note % not found', p_credit_note_id USING ERRCODE = 'ERP04';
  END IF;
  IF cn.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted credit notes can be cancelled (this one is %)', cn.status
      USING ERRCODE = 'ERP02';
  END IF;
  PERFORM 1 FROM erp.sales_invoices WHERE tenant_id = v_tenant AND id = cn.invoice_id FOR NO KEY UPDATE;
  PERFORM erp.assert_period_open(cn.branch_id, cn.note_date);

  -- Restocked goods leave stock again (fails if they were already resold).
  FOR r IN
    SELECT product_id, sum(qty_change) AS qty
    FROM erp.stock_movements
    WHERE tenant_id = v_tenant AND ref_type = 'credit_note' AND ref_id = cn.id AND movement_type = 'sale_return'
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    PERFORM erp.apply_stock_movement(cn.branch_id, r.product_id, 'sale_return_cancel', -r.qty,
                                     'credit_note', cn.id, p_reason);
  END LOOP;

  IF cn.party_id IS NOT NULL AND cn.grand_total > 0 THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, debit, narration)
    VALUES
      (v_tenant, cn.party_id, cn.branch_id, erp.today(), 'credit_note_cancel', cn.id, cn.note_no,
       cn.grand_total, 'Cancelled: ' || p_reason);
  END IF;

  UPDATE erp.sales_invoices SET amount_credited = amount_credited - cn.grand_total
  WHERE tenant_id = v_tenant AND id = cn.invoice_id;

  UPDATE erp.credit_notes
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = erp.current_user_id(),
         cancel_reason = p_reason
   WHERE id = cn.id;
END $$;

RESET ROLE;
