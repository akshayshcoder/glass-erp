-- =============================================================================
-- 007_quotations.sql
-- Quotations / estimates. No stock, no ledger, no GST effect.
--
--   draft --issue--> issued --> accepted / rejected
--                      |            |
--                      +--convert---+--> converted (creates a DRAFT invoice)
--   draft / issued / accepted --cancel--> cancelled
--
-- An issued quotation is frozen (the customer has seen it). To change prices,
-- cancel and issue a new one. Expiry (valid_until) is informational: the shop
-- decides whether to honour an old price.
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

CREATE TABLE erp.quotations (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id         uuid          NOT NULL,
  status            text          NOT NULL DEFAULT 'draft' CHECK (status IN
                      ('draft', 'issued', 'accepted', 'rejected', 'converted', 'cancelled')),
  quote_no          text,
  financial_year    text,
  quote_date        date          NOT NULL DEFAULT erp.today(),
  valid_until       date,
  supply_type       text          NOT NULL CHECK (supply_type IN ('b2b', 'b2c')),
  party_id          uuid,
  customer_name     text          NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_gstin    text          CHECK (customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  customer_phone    text,
  billing_address   text,
  shipping_address  text,
  place_of_supply   char(2)       NOT NULL REFERENCES erp.states (code),
  seller_state_code char(2)       NOT NULL REFERENCES erp.states (code),
  taxable_value     numeric(14,2) NOT NULL DEFAULT 0 CHECK (taxable_value >= 0),
  cgst_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  round_off         numeric(4,2)  NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -1 AND 1),
  grand_total       numeric(14,2) NOT NULL DEFAULT 0,
  notes             text,
  terms             text,                             -- delivery, fitting, payment terms
  invoice_id        uuid,                             -- set when converted
  issued_at         timestamptz,
  issued_by         uuid,
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
  FOREIGN KEY (tenant_id, party_id)   REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp.sales_invoices (tenant_id, id),
  CHECK (supply_type = 'b2c' OR (party_id IS NOT NULL AND customer_gstin IS NOT NULL)),
  CHECK (CASE WHEN place_of_supply <> seller_state_code
              THEN cgst_amount = 0 AND sgst_amount = 0
              ELSE igst_amount = 0 AND cgst_amount = sgst_amount END),
  CHECK (grand_total = taxable_value + cgst_amount + sgst_amount + igst_amount + round_off),
  CHECK (valid_until IS NULL OR valid_until >= quote_date),
  CHECK (status = 'draft' OR status = 'cancelled' OR (quote_no IS NOT NULL AND issued_at IS NOT NULL)),
  CHECK (status <> 'converted' OR invoice_id IS NOT NULL),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
CREATE UNIQUE INDEX quotations_no_uq
  ON erp.quotations (tenant_id, branch_id, financial_year, quote_no) WHERE quote_no IS NOT NULL;
CREATE INDEX quotations_party_idx ON erp.quotations (tenant_id, party_id, quote_date);

CREATE TABLE erp.quotation_lines (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  quotation_id    uuid          NOT NULL,
  line_no         smallint      NOT NULL CHECK (line_no > 0),
  product_id      uuid          NOT NULL,
  description     text          NOT NULL,
  hsn_code        text          NOT NULL CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  unit_code       text          NOT NULL REFERENCES erp.units (code),
  size_unit       text          CHECK (size_unit IN ('mm', 'cm', 'inch', 'ft', 'm')),
  width           numeric(10,3) CHECK (width > 0),
  height          numeric(10,3) CHECK (height > 0),
  length          numeric(10,3) CHECK (length > 0),
  pieces          int           CHECK (pieces > 0),
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
  UNIQUE (quotation_id, line_no),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES erp.quotations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id)   REFERENCES erp.products (tenant_id, id),
  CHECK (size_unit IS NOT NULL OR (width IS NULL AND height IS NULL AND length IS NULL)),
  CHECK (cgst_amount = sgst_amount),
  CHECK (igst_amount = 0 OR cgst_amount = 0),
  CHECK (abs(cgst_amount + sgst_amount + igst_amount - taxable_value * gst_rate / 100) <= 0.02)
);
CREATE INDEX quotation_lines_quote_idx ON erp.quotation_lines (tenant_id, quotation_id);

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.quotations
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document(
    'quote_no,financial_year,invoice_id,issued_at,issued_by,cancelled_at,cancelled_by,cancel_reason',
    'invoice_id,cancelled_at,cancelled_by,cancel_reason');
CREATE TRIGGER t20_stamp BEFORE INSERT OR UPDATE ON erp.quotations
  FOR EACH ROW EXECUTE FUNCTION erp.stamp_row();
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.quotations
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.quotation_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document_child('quotations', 'quotation_id');
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.quotation_lines
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

-- =============================================================================
CREATE FUNCTION erp.issue_quotation(p_quotation_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  qt       erp.quotations%ROWTYPE;
  tot      record;
  v_no     text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');

  SELECT * INTO qt FROM erp.quotations WHERE tenant_id = v_tenant AND id = p_quotation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation % not found', p_quotation_id USING ERRCODE = 'ERP04';
  END IF;
  IF qt.status <> 'draft' THEN
    IF qt.quote_no IS NOT NULL THEN
      RETURN qt.quote_no;                         -- already issued
    END IF;
    RAISE EXCEPTION 'Quotation is %', qt.status USING ERRCODE = 'ERP02';
  END IF;
  IF qt.quote_date > erp.today() THEN
    RAISE EXCEPTION 'Quotation date cannot be in the future' USING ERRCODE = 'ERP04';
  END IF;

  SELECT count(*) AS n,
         coalesce(sum(taxable_value), 0) AS tv, coalesce(sum(cgst_amount), 0) AS c,
         coalesce(sum(sgst_amount), 0)   AS s,  coalesce(sum(igst_amount), 0) AS i
    INTO tot
    FROM erp.quotation_lines WHERE tenant_id = v_tenant AND quotation_id = qt.id;
  IF tot.n = 0 THEN
    RAISE EXCEPTION 'Quotation has no lines' USING ERRCODE = 'ERP04';
  END IF;
  IF (tot.tv, tot.c, tot.s, tot.i)
     IS DISTINCT FROM (qt.taxable_value, qt.cgst_amount, qt.sgst_amount, qt.igst_amount) THEN
    RAISE EXCEPTION 'Quotation totals do not match its lines' USING ERRCODE = 'ERP04';
  END IF;

  v_no := erp.next_document_number(qt.branch_id, 'quotation', qt.quote_date);
  UPDATE erp.quotations
     SET status = 'issued', quote_no = v_no, financial_year = erp.financial_year_of(qt.quote_date),
         issued_at = now(), issued_by = erp.current_user_id()
   WHERE id = qt.id;
  RETURN v_no;
END $$;

-- Customer's answer.
CREATE FUNCTION erp.set_quotation_response(p_quotation_id uuid, p_accepted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  v_status text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');
  SELECT status INTO v_status FROM erp.quotations
  WHERE tenant_id = v_tenant AND id = p_quotation_id FOR NO KEY UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Quotation % not found', p_quotation_id USING ERRCODE = 'ERP04';
  END IF;
  IF v_status NOT IN ('issued', 'accepted', 'rejected') THEN
    RAISE EXCEPTION 'Quotation is %', v_status USING ERRCODE = 'ERP02';
  END IF;
  UPDATE erp.quotations SET status = CASE WHEN p_accepted THEN 'accepted' ELSE 'rejected' END
  WHERE id = p_quotation_id;
END $$;

-- Creates a DRAFT invoice with the quotation's customer and lines, dated today.
-- Staff can still adjust the draft (e.g. actual cut sizes) before posting it.
-- Safe to call twice: returns the same invoice.
CREATE FUNCTION erp.convert_quotation_to_invoice(p_quotation_id uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant  uuid := erp.require_tenant_id();
  qt        erp.quotations%ROWTYPE;
  v_invoice uuid;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');

  SELECT * INTO qt FROM erp.quotations WHERE tenant_id = v_tenant AND id = p_quotation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quotation % not found', p_quotation_id USING ERRCODE = 'ERP04';
  END IF;
  IF qt.status = 'converted' THEN
    RETURN qt.invoice_id;
  END IF;
  IF qt.status NOT IN ('issued', 'accepted') THEN
    RAISE EXCEPTION 'Only issued or accepted quotations can be converted (this one is %)', qt.status
      USING ERRCODE = 'ERP02';
  END IF;

  INSERT INTO erp.sales_invoices
    (tenant_id, branch_id, supply_type, party_id, customer_name, customer_gstin, customer_phone,
     billing_address, shipping_address, place_of_supply, seller_state_code,
     taxable_value, cgst_amount, sgst_amount, igst_amount, round_off, grand_total, notes)
  VALUES
    (v_tenant, qt.branch_id, qt.supply_type, qt.party_id, qt.customer_name, qt.customer_gstin,
     qt.customer_phone, qt.billing_address, qt.shipping_address, qt.place_of_supply, qt.seller_state_code,
     qt.taxable_value, qt.cgst_amount, qt.sgst_amount, qt.igst_amount, qt.round_off, qt.grand_total,
     'From quotation ' || qt.quote_no)
  RETURNING id INTO v_invoice;

  INSERT INTO erp.sales_invoice_lines
    (tenant_id, invoice_id, line_no, product_id, description, hsn_code, unit_code, size_unit,
     width, height, length, pieces, qty, rate, discount_amount, taxable_value, gst_rate,
     cgst_amount, sgst_amount, igst_amount)
  SELECT v_tenant, v_invoice, line_no, product_id, description, hsn_code, unit_code, size_unit,
         width, height, length, pieces, qty, rate, discount_amount, taxable_value, gst_rate,
         cgst_amount, sgst_amount, igst_amount
  FROM erp.quotation_lines
  WHERE tenant_id = v_tenant AND quotation_id = qt.id;

  UPDATE erp.quotations SET status = 'converted', invoice_id = v_invoice WHERE id = qt.id;
  RETURN v_invoice;
END $$;

CREATE FUNCTION erp.cancel_quotation(p_quotation_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  v_status text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required' USING ERRCODE = 'ERP04';
  END IF;
  SELECT status INTO v_status FROM erp.quotations
  WHERE tenant_id = v_tenant AND id = p_quotation_id FOR NO KEY UPDATE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'Quotation % not found', p_quotation_id USING ERRCODE = 'ERP04';
  END IF;
  IF v_status IN ('converted', 'cancelled') THEN
    RAISE EXCEPTION 'Quotation is already %', v_status USING ERRCODE = 'ERP02';
  END IF;
  UPDATE erp.quotations
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = erp.current_user_id(),
         cancel_reason = p_reason
   WHERE id = p_quotation_id;
END $$;

RESET ROLE;
