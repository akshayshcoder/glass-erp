-- =============================================================================
-- 004_sales.sql
-- Document numbering, sales invoices (B2B / B2C GST), customer ledger, receipts.
--
-- Lifecycle:  draft  --post-->  posted  --cancel-->  cancelled
--   * The API freely creates/edits DRAFTS (lines, prices, customer).
--   * erp.post_sales_invoice() does everything in ONE transaction:
--       validate -> reduce stock -> take invoice number -> customer ledger -> freeze.
--     If any step fails, nothing happens (atomicity).
--   * A posted invoice is never edited or deleted. Mistakes are fixed by
--     cancelling (before GST filing) or a credit note (after filing, Step 2).
--
-- Lock order (prevents deadlocks; every function follows it):
--   document row -> invoices (by id) -> stock balances (by product_id) -> number series
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

-- ---------- Number series ------------------------------------------------------
-- GST: invoice numbers are unique per financial year, consecutive, at most 16
-- characters of A-Z 0-9 / -.  Format: <branch><type><yyyy>/<n>  e.g. MAIN2627/00042
CREATE TABLE erp.document_series (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id      uuid        NOT NULL,
  doc_type       text        NOT NULL CHECK (doc_type IN
                   ('sales_invoice', 'receipt', 'credit_note', 'purchase', 'supplier_payment', 'quotation')),
  financial_year text        NOT NULL CHECK (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  prefix         text        NOT NULL CHECK (prefix ~ '^[A-Z0-9/-]*$'),
  next_number    int         NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  padding        smallint    NOT NULL DEFAULT 5 CHECK (padding BETWEEN 1 AND 10),
  last_doc_date  date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  version        int         NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, branch_id, doc_type, financial_year),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  CHECK (length(prefix) + padding <= 16)
);
CREATE TRIGGER document_series_stamp BEFORE INSERT OR UPDATE ON erp.document_series
  FOR EACH ROW EXECUTE FUNCTION erp.stamp_row();

-- Internal. The row lock on the series is held until COMMIT, so numbers are
-- gap-free: a rolled-back invoice also rolls back its number.
CREATE FUNCTION erp.next_document_number(p_branch_id uuid, p_doc_type text, p_doc_date date)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  v_fy     text := erp.financial_year_of(p_doc_date);
  v_series erp.document_series%ROWTYPE;
  v_n      text;
  v_no     text;
BEGIN
  INSERT INTO erp.document_series (tenant_id, branch_id, doc_type, financial_year, prefix)
  SELECT v_tenant, b.id, p_doc_type, v_fy,
         b.code
         || CASE p_doc_type WHEN 'sales_invoice' THEN '' WHEN 'receipt' THEN 'R'
                            WHEN 'credit_note' THEN 'CN' WHEN 'purchase' THEN 'P'
                            WHEN 'supplier_payment' THEN 'V' ELSE 'Q' END
         || replace(substr(v_fy, 3), '-', '') || '/'         -- '2026-27' -> '2627'
  FROM erp.branches b WHERE b.tenant_id = v_tenant AND b.id = p_branch_id
  ON CONFLICT (tenant_id, branch_id, doc_type, financial_year) DO NOTHING;

  SELECT * INTO v_series FROM erp.document_series
  WHERE tenant_id = v_tenant AND branch_id = p_branch_id
    AND doc_type = p_doc_type AND financial_year = v_fy
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Branch % not found', p_branch_id USING ERRCODE = 'ERP04';
  END IF;

  -- Numbers must follow dates: no back-dating before the last issued document.
  IF p_doc_date < v_series.last_doc_date THEN
    RAISE EXCEPTION 'Date % is before the last % date %', p_doc_date, p_doc_type, v_series.last_doc_date
      USING ERRCODE = 'ERP04';
  END IF;

  UPDATE erp.document_series
     SET next_number = next_number + 1, last_doc_date = p_doc_date
   WHERE id = v_series.id;

  v_n  := v_series.next_number::text;
  v_no := v_series.prefix
          || CASE WHEN length(v_n) >= v_series.padding THEN v_n
                  ELSE lpad(v_n, v_series.padding, '0') END;
  IF length(v_no) > 16 AND p_doc_type IN ('sales_invoice', 'credit_note') THEN
    RAISE EXCEPTION 'Document number % exceeds 16 characters', v_no USING ERRCODE = 'ERP04';
  END IF;
  RETURN v_no;
END $$;

-- ---------- Sales invoices -------------------------------------------------------
CREATE TABLE erp.sales_invoices (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id          uuid          NOT NULL,
  status             text          NOT NULL DEFAULT 'draft'
                                   CHECK (status IN ('draft', 'posted', 'cancelled')),
  invoice_no         text,
  financial_year     text,
  invoice_date       date          NOT NULL DEFAULT erp.today(),
  due_date           date,
  supply_type        text          NOT NULL CHECK (supply_type IN ('b2b', 'b2c')),
  party_id           uuid,                          -- NULL = walk-in customer
  -- Snapshot at billing time: later edits to the customer/branch master must
  -- never change an issued invoice.
  customer_name      text          NOT NULL CHECK (btrim(customer_name) <> ''),
  customer_gstin     text          CHECK (customer_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  customer_phone     text,
  billing_address    text,
  shipping_address   text,
  place_of_supply    char(2)       NOT NULL REFERENCES erp.states (code),
  seller_state_code  char(2)       NOT NULL REFERENCES erp.states (code),
  seller_gstin       text,                          -- set at posting from the branch
  reverse_charge     boolean       NOT NULL DEFAULT false,
  taxable_value      numeric(14,2) NOT NULL DEFAULT 0 CHECK (taxable_value >= 0),
  cgst_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (cgst_amount >= 0),
  sgst_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (sgst_amount >= 0),
  igst_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (igst_amount >= 0),
  round_off          numeric(4,2)  NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -1 AND 1),
  grand_total        numeric(14,2) NOT NULL DEFAULT 0,
  amount_paid        numeric(14,2) NOT NULL DEFAULT 0,
  amount_credited    numeric(14,2) NOT NULL DEFAULT 0,  -- total of posted credit notes
  notes              text,
  idempotency_key    text,                          -- stops double-submit (double click / retry)
  posted_at          timestamptz,
  posted_by          uuid,
  cancelled_at       timestamptz,
  cancelled_by       uuid,
  cancel_reason      text,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  updated_by         uuid,
  version            int           NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id)  REFERENCES erp.parties (tenant_id, id),
  CHECK (supply_type = 'b2c' OR (party_id IS NOT NULL AND customer_gstin IS NOT NULL)),
  -- Same state: CGST + SGST (equal halves). Other state: IGST only.
  CHECK (CASE WHEN place_of_supply <> seller_state_code
              THEN cgst_amount = 0 AND sgst_amount = 0
              ELSE igst_amount = 0 AND cgst_amount = sgst_amount END),
  CHECK (grand_total = taxable_value + cgst_amount + sgst_amount + igst_amount + round_off),
  CHECK (amount_paid >= 0 AND amount_paid <= grand_total),
  CHECK (amount_credited >= 0 AND amount_credited <= grand_total),
  CHECK (status = 'draft' OR (invoice_no IS NOT NULL AND financial_year IS NOT NULL
                              AND posted_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> '')),
  CHECK (due_date IS NULL OR due_date >= invoice_date)
);
CREATE UNIQUE INDEX sales_invoices_no_uq
  ON erp.sales_invoices (tenant_id, branch_id, financial_year, invoice_no) WHERE invoice_no IS NOT NULL;
CREATE UNIQUE INDEX sales_invoices_idem_uq
  ON erp.sales_invoices (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX sales_invoices_date_idx  ON erp.sales_invoices (tenant_id, invoice_date);
CREATE INDEX sales_invoices_party_idx ON erp.sales_invoices (tenant_id, party_id, invoice_date);

CREATE TABLE erp.sales_invoice_lines (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  invoice_id      uuid          NOT NULL,
  line_no         smallint      NOT NULL CHECK (line_no > 0),
  product_id      uuid          NOT NULL,
  description     text          NOT NULL,
  hsn_code        text          NOT NULL CHECK (hsn_code ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
  unit_code       text          NOT NULL REFERENCES erp.units (code),
  -- Size entry (glass: width x height, aluminium: length). qty is the billed
  -- quantity in unit_code, calculated by the API from these.
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
  UNIQUE (invoice_id, line_no),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp.sales_invoices (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES erp.products (tenant_id, id),
  CHECK (size_unit IS NOT NULL OR (width IS NULL AND height IS NULL AND length IS NULL)),
  CHECK (cgst_amount = sgst_amount),
  CHECK (igst_amount = 0 OR cgst_amount = 0),
  -- Tax must match the rate (1 paisa per half for rounding).
  CHECK (abs(cgst_amount + sgst_amount + igst_amount - taxable_value * gst_rate / 100) <= 0.02)
);
CREATE INDEX sales_invoice_lines_invoice_idx ON erp.sales_invoice_lines (tenant_id, invoice_id);
CREATE INDEX sales_invoice_lines_product_idx ON erp.sales_invoice_lines (tenant_id, product_id);

-- ---------- Party ledger (customers AND suppliers, append-only) ----------------
-- Always from the shop's point of view.  balance = sum(debit) - sum(credit)
--   debit  : party owes us more  (sales invoice, payment we made to a supplier)
--   credit : party owes us less  (receipt, credit note, supplier's purchase bill)
--   balance > 0 -> they owe us;  balance < 0 -> we owe them
CREATE TABLE erp.party_ledger (
  id         bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  party_id   uuid          NOT NULL,
  branch_id  uuid,
  entry_date date          NOT NULL,
  entry_type text          NOT NULL CHECK (entry_type IN
               ('opening', 'sales_invoice', 'sales_invoice_cancel', 'receipt', 'receipt_cancel',
                'credit_note', 'credit_note_cancel', 'purchase', 'purchase_cancel',
                'supplier_payment', 'supplier_payment_cancel')),
  ref_id     uuid,
  ref_no     text,
  debit      numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit     numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  narration  text,
  created_at timestamptz   NOT NULL DEFAULT now(),
  created_by uuid          DEFAULT erp.current_user_id(),
  FOREIGN KEY (tenant_id, party_id)  REFERENCES erp.parties (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  CHECK ((debit > 0) <> (credit > 0))              -- exactly one side
);
CREATE INDEX party_ledger_party_idx ON erp.party_ledger (tenant_id, party_id, entry_date, id);
CREATE UNIQUE INDEX party_ledger_one_opening_uq ON erp.party_ledger (tenant_id, party_id)
  WHERE entry_type = 'opening';
CREATE TRIGGER party_ledger_append_only BEFORE UPDATE OR DELETE ON erp.party_ledger
  FOR EACH ROW EXECUTE FUNCTION erp.forbid_change();

-- ---------- Receipts (money received) ----------------------------------------
CREATE TABLE erp.receipts (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id       uuid          NOT NULL,
  status          text          NOT NULL DEFAULT 'draft'
                                CHECK (status IN ('draft', 'posted', 'cancelled')),
  receipt_no      text,
  financial_year  text,
  receipt_date    date          NOT NULL DEFAULT erp.today(),
  party_id        uuid,                         -- NULL = walk-in, must be fully allocated
  mode            text          NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'bank_transfer', 'cheque')),
  amount          numeric(14,2) NOT NULL CHECK (amount > 0),
  reference_no    text,                         -- UTR / cheque no.
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
  FOREIGN KEY (tenant_id, branch_id) REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, party_id)  REFERENCES erp.parties (tenant_id, id),
  CHECK (status = 'draft' OR (receipt_no IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status <> 'cancelled' OR (cancelled_at IS NOT NULL AND btrim(coalesce(cancel_reason, '')) <> ''))
);
CREATE UNIQUE INDEX receipts_no_uq
  ON erp.receipts (tenant_id, branch_id, financial_year, receipt_no) WHERE receipt_no IS NOT NULL;
CREATE UNIQUE INDEX receipts_idem_uq
  ON erp.receipts (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX receipts_party_idx ON erp.receipts (tenant_id, party_id, receipt_date);

CREATE TABLE erp.receipt_allocations (
  id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  receipt_id uuid          NOT NULL,
  invoice_id uuid          NOT NULL,
  amount     numeric(14,2) NOT NULL CHECK (amount > 0),
  UNIQUE (receipt_id, invoice_id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES erp.receipts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES erp.sales_invoices (tenant_id, id)
);
CREATE INDEX receipt_allocations_invoice_idx ON erp.receipt_allocations (tenant_id, invoice_id);

-- ---------- Triggers -------------------------------------------------------------
-- Names start with a number: BEFORE triggers fire in name order (guard first).
CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document(
    'invoice_no,financial_year,amount_paid,amount_credited,seller_gstin,posted_at,posted_by,cancelled_at,cancelled_by,cancel_reason',
    'amount_paid,amount_credited,cancelled_at,cancelled_by,cancel_reason');
CREATE TRIGGER t20_stamp BEFORE INSERT OR UPDATE ON erp.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION erp.stamp_row();
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document_child('sales_invoices', 'invoice_id');
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.receipts
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document(
    'receipt_no,financial_year,posted_at,posted_by,cancelled_at,cancelled_by,cancel_reason',
    'cancelled_at,cancelled_by,cancel_reason');
CREATE TRIGGER t20_stamp BEFORE INSERT OR UPDATE ON erp.receipts
  FOR EACH ROW EXECUTE FUNCTION erp.stamp_row();
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.receipts
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

CREATE TRIGGER t10_guard BEFORE INSERT OR UPDATE OR DELETE ON erp.receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION erp.guard_document_child('receipts', 'receipt_id');
CREATE TRIGGER t90_audit AFTER INSERT OR UPDATE OR DELETE ON erp.receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION audit.capture_row_change();

-- =============================================================================
-- Business functions (the API calls these; each is one atomic unit)
-- =============================================================================

-- Post a draft invoice. Safe to call twice (returns the same number).
CREATE FUNCTION erp.post_sales_invoice(p_invoice_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  inv      erp.sales_invoices%ROWTYPE;
  br       erp.branches%ROWTYPE;
  tot      record;
  r        record;
  v_no     text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');

  SELECT * INTO inv FROM erp.sales_invoices
  WHERE tenant_id = v_tenant AND id = p_invoice_id
  FOR NO KEY UPDATE;                                   -- 1. lock the document
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id USING ERRCODE = 'ERP04';
  END IF;
  IF inv.status = 'posted' THEN
    RETURN inv.invoice_no;                      -- retry of a successful call
  END IF;
  IF inv.status <> 'draft' THEN
    RAISE EXCEPTION 'Invoice is %', inv.status USING ERRCODE = 'ERP02';
  END IF;
  IF inv.invoice_date > erp.today() THEN
    RAISE EXCEPTION 'Invoice date cannot be in the future' USING ERRCODE = 'ERP04';
  END IF;

  SELECT * INTO br FROM erp.branches WHERE tenant_id = v_tenant AND id = inv.branch_id;
  IF NOT br.is_active THEN
    RAISE EXCEPTION 'Branch % is inactive', br.code USING ERRCODE = 'ERP04';
  END IF;
  IF br.state_code <> inv.seller_state_code THEN
    RAISE EXCEPTION 'Seller state on the invoice does not match the branch' USING ERRCODE = 'ERP04';
  END IF;
  IF br.gstin IS NULL AND (inv.cgst_amount + inv.sgst_amount + inv.igst_amount) > 0 THEN
    RAISE EXCEPTION 'Branch has no GSTIN, it cannot charge GST' USING ERRCODE = 'ERP04';
  END IF;
  IF inv.party_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM erp.parties WHERE tenant_id = v_tenant AND id = inv.party_id
         AND kind IN ('customer', 'both')) THEN
    RAISE EXCEPTION 'Party is not a customer' USING ERRCODE = 'ERP04';
  END IF;
  PERFORM erp.assert_period_open(inv.branch_id, inv.invoice_date);

  -- Header totals must equal the sum of the lines.
  SELECT count(*) AS n,
         coalesce(sum(taxable_value), 0) AS tv, coalesce(sum(cgst_amount), 0) AS c,
         coalesce(sum(sgst_amount), 0)   AS s,  coalesce(sum(igst_amount), 0) AS i
    INTO tot
    FROM erp.sales_invoice_lines WHERE tenant_id = v_tenant AND invoice_id = inv.id;
  IF tot.n = 0 THEN
    RAISE EXCEPTION 'Invoice has no lines' USING ERRCODE = 'ERP04';
  END IF;
  IF (tot.tv, tot.c, tot.s, tot.i)
     IS DISTINCT FROM (inv.taxable_value, inv.cgst_amount, inv.sgst_amount, inv.igst_amount) THEN
    RAISE EXCEPTION 'Invoice totals do not match its lines' USING ERRCODE = 'ERP04';
  END IF;

  -- 2. stock, one movement per product, locked in product_id order
  FOR r IN
    SELECT l.product_id, sum(l.qty) AS qty
    FROM erp.sales_invoice_lines l
    JOIN erp.products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id
    WHERE l.tenant_id = v_tenant AND l.invoice_id = inv.id AND p.track_inventory
    GROUP BY l.product_id
    ORDER BY l.product_id
  LOOP
    PERFORM erp.apply_stock_movement(inv.branch_id, r.product_id, 'sale', -r.qty,
                                     'sales_invoice', inv.id);
  END LOOP;

  -- 3. number
  v_no := erp.next_document_number(inv.branch_id, 'sales_invoice', inv.invoice_date);

  -- 4. customer ledger
  IF inv.party_id IS NOT NULL AND inv.grand_total > 0 THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, debit, narration)
    VALUES
      (v_tenant, inv.party_id, inv.branch_id, inv.invoice_date, 'sales_invoice', inv.id, v_no,
       inv.grand_total, 'Sales invoice ' || v_no);
  END IF;

  -- 5. freeze
  UPDATE erp.sales_invoices
     SET status = 'posted', invoice_no = v_no,
         financial_year = erp.financial_year_of(inv.invoice_date),
         seller_gstin = br.gstin, posted_at = now(), posted_by = erp.current_user_id()
   WHERE id = inv.id;

  RETURN v_no;
END $$;

-- Cancel a posted invoice: stock comes back, ledger is reversed. Payments must
-- be cancelled first. (After GST filing, use a credit note instead - Step 2.)
CREATE FUNCTION erp.cancel_sales_invoice(p_invoice_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  inv      erp.sales_invoices%ROWTYPE;
  r        record;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required' USING ERRCODE = 'ERP04';
  END IF;

  SELECT * INTO inv FROM erp.sales_invoices
  WHERE tenant_id = v_tenant AND id = p_invoice_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invoice % not found', p_invoice_id USING ERRCODE = 'ERP04';
  END IF;
  IF inv.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted invoices can be cancelled (this one is %)', inv.status
      USING ERRCODE = 'ERP02';
  END IF;
  IF inv.amount_paid > 0 THEN
    RAISE EXCEPTION 'Invoice has payments of %; cancel those receipts first', inv.amount_paid
      USING ERRCODE = 'ERP02';
  END IF;
  IF inv.amount_credited > 0 THEN
    RAISE EXCEPTION 'Invoice has credit notes of %; cancel those first', inv.amount_credited
      USING ERRCODE = 'ERP02';
  END IF;
  -- Once the month is filed, the invoice is in the GST return: use a credit note.
  PERFORM erp.assert_period_open(inv.branch_id, inv.invoice_date);

  FOR r IN
    SELECT product_id, -sum(qty_change) AS qty
    FROM erp.stock_movements
    WHERE tenant_id = v_tenant AND ref_type = 'sales_invoice' AND ref_id = inv.id
      AND movement_type = 'sale'
    GROUP BY product_id
    ORDER BY product_id
  LOOP
    PERFORM erp.apply_stock_movement(inv.branch_id, r.product_id, 'sale_cancel', r.qty,
                                     'sales_invoice', inv.id, p_reason);
  END LOOP;

  IF inv.party_id IS NOT NULL AND inv.grand_total > 0 THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, credit, narration)
    VALUES
      (v_tenant, inv.party_id, inv.branch_id, erp.today(), 'sales_invoice_cancel', inv.id,
       inv.invoice_no, inv.grand_total, 'Cancelled: ' || p_reason);
  END IF;

  UPDATE erp.sales_invoices
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = erp.current_user_id(),
         cancel_reason = p_reason
   WHERE id = inv.id;
END $$;

-- Post a receipt and apply its allocations to invoices.
CREATE FUNCTION erp.post_receipt(p_receipt_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant    uuid := erp.require_tenant_id();
  rc          erp.receipts%ROWTYPE;
  inv         erp.sales_invoices%ROWTYPE;
  a           record;
  v_allocated numeric(14,2);
  v_no        text;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'billing');

  SELECT * INTO rc FROM erp.receipts
  WHERE tenant_id = v_tenant AND id = p_receipt_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt % not found', p_receipt_id USING ERRCODE = 'ERP04';
  END IF;
  IF rc.status = 'posted' THEN
    RETURN rc.receipt_no;
  END IF;
  IF rc.status <> 'draft' THEN
    RAISE EXCEPTION 'Receipt is %', rc.status USING ERRCODE = 'ERP02';
  END IF;
  IF rc.receipt_date > erp.today() THEN
    RAISE EXCEPTION 'Receipt date cannot be in the future' USING ERRCODE = 'ERP04';
  END IF;

  SELECT coalesce(sum(amount), 0) INTO v_allocated
  FROM erp.receipt_allocations WHERE tenant_id = v_tenant AND receipt_id = rc.id;
  IF v_allocated > rc.amount THEN
    RAISE EXCEPTION 'Allocated % is more than the received %', v_allocated, rc.amount
      USING ERRCODE = 'ERP04';
  END IF;
  IF rc.party_id IS NULL AND v_allocated <> rc.amount THEN
    RAISE EXCEPTION 'A walk-in receipt must be fully allocated to invoices' USING ERRCODE = 'ERP04';
  END IF;

  FOR a IN
    SELECT invoice_id, amount FROM erp.receipt_allocations
    WHERE tenant_id = v_tenant AND receipt_id = rc.id
    ORDER BY invoice_id
  LOOP
    SELECT * INTO inv FROM erp.sales_invoices
    WHERE tenant_id = v_tenant AND id = a.invoice_id
    FOR NO KEY UPDATE;
    IF inv.status <> 'posted' THEN
      RAISE EXCEPTION 'Invoice % is %, payments need a posted invoice', inv.id, inv.status
        USING ERRCODE = 'ERP02';
    END IF;
    IF inv.party_id IS DISTINCT FROM rc.party_id THEN
      RAISE EXCEPTION 'Invoice % belongs to another customer', inv.invoice_no USING ERRCODE = 'ERP04';
    END IF;
    IF inv.amount_paid + inv.amount_credited + a.amount > inv.grand_total THEN
      RAISE EXCEPTION 'Payment exceeds the balance of invoice %', inv.invoice_no
        USING ERRCODE = 'ERP04',
              DETAIL = format('balance=%s payment=%s',
                              inv.grand_total - inv.amount_credited - inv.amount_paid, a.amount);
    END IF;
    UPDATE erp.sales_invoices SET amount_paid = amount_paid + a.amount WHERE id = inv.id;
  END LOOP;

  v_no := erp.next_document_number(rc.branch_id, 'receipt', rc.receipt_date);

  IF rc.party_id IS NOT NULL THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, credit, narration)
    VALUES
      (v_tenant, rc.party_id, rc.branch_id, rc.receipt_date, 'receipt', rc.id, v_no, rc.amount,
       'Receipt ' || v_no || ' (' || rc.mode || ')');
  END IF;

  UPDATE erp.receipts
     SET status = 'posted', receipt_no = v_no,
         financial_year = erp.financial_year_of(rc.receipt_date),
         posted_at = now(), posted_by = erp.current_user_id()
   WHERE id = rc.id;

  RETURN v_no;
END $$;

CREATE FUNCTION erp.cancel_receipt(p_receipt_id uuid, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
  rc       erp.receipts%ROWTYPE;
  a        record;
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A cancellation reason is required' USING ERRCODE = 'ERP04';
  END IF;

  SELECT * INTO rc FROM erp.receipts
  WHERE tenant_id = v_tenant AND id = p_receipt_id
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt % not found', p_receipt_id USING ERRCODE = 'ERP04';
  END IF;
  IF rc.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted receipts can be cancelled (this one is %)', rc.status
      USING ERRCODE = 'ERP02';
  END IF;

  FOR a IN
    SELECT invoice_id, amount FROM erp.receipt_allocations
    WHERE tenant_id = v_tenant AND receipt_id = rc.id
    ORDER BY invoice_id
  LOOP
    PERFORM 1 FROM erp.sales_invoices WHERE tenant_id = v_tenant AND id = a.invoice_id FOR NO KEY UPDATE;
    UPDATE erp.sales_invoices SET amount_paid = amount_paid - a.amount
    WHERE tenant_id = v_tenant AND id = a.invoice_id;
  END LOOP;

  IF rc.party_id IS NOT NULL THEN
    INSERT INTO erp.party_ledger
      (tenant_id, party_id, branch_id, entry_date, entry_type, ref_id, ref_no, debit, narration)
    VALUES
      (v_tenant, rc.party_id, rc.branch_id, erp.today(), 'receipt_cancel', rc.id, rc.receipt_no,
       rc.amount, 'Cancelled: ' || p_reason);
  END IF;

  UPDATE erp.receipts
     SET status = 'cancelled', cancelled_at = now(), cancelled_by = erp.current_user_id(),
         cancel_reason = p_reason
   WHERE id = rc.id;
END $$;

-- Opening balance when moving a customer/supplier from paper books.
-- p_amount > 0: they owe us.  p_amount < 0: we owe them.  Once per party.
CREATE FUNCTION erp.post_opening_balance(p_party_id uuid, p_amount numeric, p_as_of date)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant uuid := erp.require_tenant_id();
BEGIN
  PERFORM erp.require_role('owner', 'admin');
  IF p_amount = 0 THEN
    RAISE EXCEPTION 'Opening balance cannot be zero' USING ERRCODE = 'ERP04';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM erp.parties WHERE tenant_id = v_tenant AND id = p_party_id) THEN
    RAISE EXCEPTION 'Party % not found', p_party_id USING ERRCODE = 'ERP04';
  END IF;
  INSERT INTO erp.party_ledger (tenant_id, party_id, entry_date, entry_type, debit, credit, narration)
  VALUES (v_tenant, p_party_id, p_as_of, 'opening',
          greatest(p_amount, 0), greatest(-p_amount, 0), 'Opening balance');
END $$;

-- ---------- Read models ------------------------------------------------------------
-- security_invoker: the view runs with the caller's rights, so RLS still applies.
CREATE VIEW erp.v_party_balances WITH (security_invoker = true) AS
SELECT p.tenant_id, p.id AS party_id, p.name, p.gstin, p.credit_limit,
       coalesce(sum(l.debit), 0) - coalesce(sum(l.credit), 0) AS balance,
       max(l.entry_date) AS last_entry_date
FROM erp.parties p
LEFT JOIN erp.party_ledger l ON l.tenant_id = p.tenant_id AND l.party_id = p.id
GROUP BY p.tenant_id, p.id;

CREATE VIEW erp.v_invoice_outstanding WITH (security_invoker = true) AS
SELECT i.tenant_id, i.id AS invoice_id, i.branch_id, i.invoice_no, i.invoice_date, i.due_date,
       i.party_id, i.customer_name, i.grand_total, i.amount_credited, i.amount_paid,
       i.grand_total - i.amount_credited - i.amount_paid AS balance_due,
       greatest(erp.today() - coalesce(i.due_date, i.invoice_date), 0) AS days_overdue
FROM erp.sales_invoices i
WHERE i.status = 'posted';

CREATE VIEW erp.v_stock WITH (security_invoker = true) AS
SELECT b.tenant_id, b.branch_id, b.product_id, p.sku, p.name, p.kind, p.unit_code,
       b.qty, p.reorder_level, b.qty <= p.reorder_level AS needs_reorder
FROM erp.stock_balances b
JOIN erp.products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id;

RESET ROLE;
