-- =============================================================================
-- 097_party_customer_type.sql
-- Customer classification shown in brackets next to the name everywhere:
--   walk_in | franchise | b2b | b2c
-- Every type is a real party with its own ledger, wallet and credit limit.
-- =============================================================================

SET ROLE erp_owner;
SET search_path = erp, pg_catalog;

ALTER TABLE erp.parties
  ADD COLUMN IF NOT EXISTS customer_type text NOT NULL DEFAULT 'b2c'
  CHECK (customer_type IN ('walk_in', 'franchise', 'b2b', 'b2c'));

-- Existing parties: GSTIN registered => B2B, otherwise B2C.
UPDATE erp.parties SET customer_type = 'b2b' WHERE gstin IS NOT NULL AND customer_type = 'b2c';

RESET ROLE;
