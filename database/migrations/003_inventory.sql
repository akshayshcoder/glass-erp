-- =============================================================================
-- 003_inventory.sql
-- Stock = an append-only movement ledger + a balance row per (branch, product).
--
-- Race-condition design
--   Two cashiers sell the last 10 sq ft of the same glass at the same moment.
--   Both run:
--       UPDATE stock_balances SET qty = qty - 7 WHERE ... AND qty - 7 >= 0
--   The first takes the row lock and commits (10 -> 3). The second waits on the
--   lock, then PostgreSQL re-checks the WHERE clause against the committed row
--   (3 - 7 < 0), so 0 rows are updated and we raise "insufficient stock".
--   No read-then-write gap, no lost update, no overselling.
--
--   Multi-item documents lock balance rows in product_id order, so two invoices
--   with the same items can never deadlock each other.
-- =============================================================================
SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

CREATE TABLE erp.stock_balances (
  tenant_id  uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id  uuid          NOT NULL,
  product_id uuid          NOT NULL,
  qty        numeric(14,3) NOT NULL DEFAULT 0,
  updated_at timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, product_id),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES erp.products (tenant_id, id)
);

CREATE TABLE erp.stock_movements (
  id            bigint        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid          NOT NULL DEFAULT erp.current_tenant_id(),
  branch_id     uuid          NOT NULL,
  product_id    uuid          NOT NULL,
  movement_type text          NOT NULL,
  qty_change    numeric(14,3) NOT NULL CHECK (qty_change <> 0),
  balance_after numeric(14,3) NOT NULL,
  ref_type      text,                       -- 'sales_invoice', 'purchase', ...
  ref_id        uuid,
  note          text,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  created_by    uuid          DEFAULT erp.current_user_id(),
  FOREIGN KEY (tenant_id, branch_id)  REFERENCES erp.branches (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES erp.products (tenant_id, id),
  CHECK (
       (movement_type IN ('opening', 'purchase', 'sale_return', 'sale_cancel',
                          'adjustment_in', 'transfer_in') AND qty_change > 0)
    OR (movement_type IN ('purchase_return', 'purchase_cancel', 'sale', 'sale_return_cancel',
                          'adjustment_out', 'transfer_out') AND qty_change < 0)),
  -- Manual corrections must say why (breakage, counting error, ...)
  CHECK (movement_type NOT LIKE 'adjustment%' OR btrim(coalesce(note, '')) <> '')
);
CREATE INDEX stock_movements_product_idx ON erp.stock_movements (tenant_id, product_id, created_at);
CREATE INDEX stock_movements_ref_idx     ON erp.stock_movements (tenant_id, ref_type, ref_id);

CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON erp.stock_movements
  FOR EACH ROW EXECUTE FUNCTION erp.forbid_change();

-- -----------------------------------------------------------------------------
-- The ONLY way stock changes. Internal: not executable by the API role.
-- Must run inside the caller's transaction (all-or-nothing with the document).
-- -----------------------------------------------------------------------------
CREATE FUNCTION erp.apply_stock_movement(
  p_branch_id  uuid,
  p_product_id uuid,
  p_type       text,
  p_qty_change numeric,
  p_ref_type   text DEFAULT NULL,
  p_ref_id     uuid DEFAULT NULL,
  p_note       text DEFAULT NULL
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
DECLARE
  v_tenant         uuid := erp.require_tenant_id();
  v_allow_negative boolean;
  v_tracks         boolean;
  v_balance        numeric(14,3);
  v_available      numeric(14,3);
BEGIN
  SELECT allow_negative_stock INTO v_allow_negative
  FROM erp.branches WHERE tenant_id = v_tenant AND id = p_branch_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Branch % not found or inactive', p_branch_id USING ERRCODE = 'ERP04';
  END IF;

  SELECT track_inventory INTO v_tracks
  FROM erp.products WHERE tenant_id = v_tenant AND id = p_product_id;
  IF NOT FOUND OR NOT v_tracks THEN
    RAISE EXCEPTION 'Product % not found or not stock-tracked', p_product_id USING ERRCODE = 'ERP04';
  END IF;

  INSERT INTO erp.stock_balances (tenant_id, branch_id, product_id)
  VALUES (v_tenant, p_branch_id, p_product_id)
  ON CONFLICT DO NOTHING;

  -- Atomic check-and-update (see header comment).
  UPDATE erp.stock_balances
     SET qty = qty + p_qty_change, updated_at = now()
   WHERE tenant_id = v_tenant AND branch_id = p_branch_id AND product_id = p_product_id
     AND (v_allow_negative OR p_qty_change > 0 OR qty + p_qty_change >= 0)
  RETURNING qty INTO v_balance;

  IF NOT FOUND THEN
    SELECT qty INTO v_available FROM erp.stock_balances
    WHERE tenant_id = v_tenant AND branch_id = p_branch_id AND product_id = p_product_id;
    RAISE EXCEPTION 'Insufficient stock' USING ERRCODE = 'ERP01',
      DETAIL = format('product=%s available=%s requested=%s', p_product_id, v_available, -p_qty_change);
  END IF;

  INSERT INTO erp.stock_movements
    (tenant_id, branch_id, product_id, movement_type, qty_change, balance_after,
     ref_type, ref_id, note)
  VALUES
    (v_tenant, p_branch_id, p_product_id, p_type, p_qty_change, v_balance,
     p_ref_type, p_ref_id, p_note);

  RETURN v_balance;
END $$;

-- -----------------------------------------------------------------------------
-- API: opening stock and manual corrections (breakage, recount, ...).
-- -----------------------------------------------------------------------------
CREATE FUNCTION erp.adjust_stock(
  p_branch_id  uuid,
  p_product_id uuid,
  p_qty_change numeric,
  p_reason     text,
  p_is_opening boolean DEFAULT false
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = erp, pg_catalog, pg_temp AS $$
BEGIN
  PERFORM erp.require_role('owner', 'admin', 'manager', 'storekeeper');
  IF btrim(coalesce(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'A reason is required for stock adjustments' USING ERRCODE = 'ERP04';
  END IF;
  IF p_is_opening AND p_qty_change <= 0 THEN
    RAISE EXCEPTION 'Opening stock must be positive' USING ERRCODE = 'ERP04';
  END IF;

  RETURN erp.apply_stock_movement(
    p_branch_id, p_product_id,
    CASE WHEN p_is_opening        THEN 'opening'
         WHEN p_qty_change > 0    THEN 'adjustment_in'
         ELSE                          'adjustment_out' END,
    p_qty_change, 'adjustment', NULL, p_reason);
END $$;

RESET ROLE;
